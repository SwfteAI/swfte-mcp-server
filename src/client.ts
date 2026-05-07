import type { ServerConfig } from './config.js';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  workspaceId?: string;
  headers?: Record<string, string>;
}

export class SwfteClient {
  constructor(private readonly config: ServerConfig) {}

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'X-API-Key': this.config.apiKey,
      'User-Agent': this.config.userAgent,
      Accept: 'application/json',
      ...opts.headers,
    };

    const workspaceId = opts.workspaceId ?? this.config.workspaceId;
    if (workspaceId) {
      headers['X-Workspace-ID'] = workspaceId;
    }

    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    if (this.config.debug) {
      process.stderr.write(`[swfte-mcp] ${opts.method} ${url}\n`);
    }

    const res = await fetch(url, { method: opts.method, headers, body });
    const text = await res.text();

    if (!res.ok) {
      const detail = text.length > 800 ? `${text.slice(0, 800)}…` : text;
      throw new Error(
        `Swfte API ${res.status} ${res.statusText} on ${opts.method} ${opts.path}: ${detail}`
      );
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.config.baseUrl}${cleanPath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}
