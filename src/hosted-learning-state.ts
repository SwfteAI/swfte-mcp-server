import { createHash } from 'node:crypto';
import type { ServerConfig } from './config.js';
import { LocalStepQueue, type PendingStep } from './tracing.js';

export interface LocalDeliveryState {
  readonly queue: LocalStepQueue;
  draining: boolean;
  inFlight: number;
  discarded: number;
  /** Consume the batch accounting once; an earlier expiry sweep already owns its count. */
  discardInFlight(): void;
  /** Expiry revokes bookkeeping, not an already dispatched backend request. */
  current(): boolean;
}
export interface HostedLearningBinding {
  scope(scope: Pick<PendingStep, 'workspaceId' | 'sessionId' | 'client'>): LocalDeliveryState | undefined;
}

/** Process-local best effort only. No credentials, clients, timers or durable records are retained. */
export class HostedLearningState {
  private readonly slots = new Map<string, { state: LocalDeliveryState; expires: number; discarded?: boolean }>();
  private discarded = 0;
  constructor(private readonly now: () => number = Date.now) {}
  get dropped(): number { this.sweep(); return this.discarded; }
  get size(): number { this.sweep(); return this.slots.size; }

  private sweep(): void {
    for (const [key, slot] of this.slots) {
      if (this.now() >= slot.expires) {
        if (!slot.discarded) this.discarded += slot.state.queue.size + slot.state.queue.dropped + slot.state.discarded + slot.state.inFlight;
        slot.discarded = true;
        while (slot.state.queue.size) slot.state.queue.takeBatch(50);
        // Retain the expired tombstone until its outstanding delivery settles: no parallel replacement.
        if (!slot.state.draining) this.slots.delete(key);
      }
    }
  }

  bind(config: ServerConfig): HostedLearningBinding {
    const owner = createHash('sha256').update(JSON.stringify([
      config.credentialKind, config.credential, config.baseUrl, config.workspaceId ?? null,
    ])).digest('hex');
    const enabled = config.telemetry !== false;
    return Object.freeze({ scope: (scope: Pick<PendingStep, 'workspaceId' | 'sessionId' | 'client'>) => {
      this.sweep();
      // Contact may drain old sessions only under the identical verified owner/workspace.
      // The queue keeps original session/client headers in homogeneous batches; never relabel.
      const key = JSON.stringify([owner, scope.workspaceId ?? null]);
      const existing = this.slots.get(key);
      if (!enabled) {
        if (existing) {
          existing.expires = this.now();
          this.sweep();
        }
        return undefined;
      }
      if (existing) return existing.state.current() ? existing.state : undefined;
      if (this.slots.size >= 256) { this.discarded++; return undefined; }
      const expires = this.now() + 300_000;
      const state: LocalDeliveryState = {
        queue: new LocalStepQueue(200), draining: false, inFlight: 0, discarded: 0,
        discardInFlight: () => {
          const count = state.inFlight;
          state.inFlight = 0;
          if (!this.slots.get(key)?.discarded) state.discarded += count;
        },
        current: () => this.slots.get(key)?.state === state && this.now() < (this.slots.get(key)?.expires ?? 0),
      };
      this.slots.set(key, { state, expires });
      return state;
    } });
  }
}
