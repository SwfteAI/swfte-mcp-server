import { createHash, createPublicKey, verify } from 'node:crypto';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { SwfteApiError } from '../client.js';
import type { ToolContext, ToolDefinition } from './_types.js';

const hash = z.string().length(71).regex(/^sha256:[0-9a-f]{64}$/);
const identity = z.string().min(1).max(512).refine(value => value.trim().length > 0 && value !== '.' && value !== '..' && !/[\x00-\x1f\x7f]/.test(value));
const actionIdentity = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const version = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const REVIEW_KINDS = ['workflow', 'agent', 'chatflow', 'model', 'application', 'widget', 'studio-change'] as const;
const subjectInput = { kind: z.enum(REVIEW_KINDS), artifactId: identity, contentHash: hash };
const sections = ['confidence', 'controlEvidence', 'securityProbes', 'approvals', 'stakeholders', 'promotions', 'runs'] as const;
const roomReportKeys = ['confidence', 'security', 'privacy', 'compliance', 'performance-cost', 'behaviour', 'what-changed', 'release-plan', 'stakeholders'] as const;
const payloadType = 'application/vnd.in-toto+json';
const maxEnvelope = 8 * 1024 * 1024;
const maxPackage = 2 * maxEnvelope + 64 * 1024;
const verifyCommand = 'cosign verify-blob-attestation --key public.pem --signature envelope.json --type https://swfte.dev/proof-bundle/v1 --offline --insecure-ignore-tlog subject.json';
type Subject = { kind: typeof REVIEW_KINDS[number]; artifactId: string; contentHash: string };
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function unavailable(path: string, code = 'PROOF_MATERIAL_UNAVAILABLE'): never {
  throw new SwfteApiError({ status: 503, code, message: 'Exact bound verification material is unavailable or inconsistent.', method: 'GET', path });
}
function bundlePath(input: Subject): string { return `/v2/proof-bundles/${encodeURIComponent(input.kind)}/${encodeURIComponent(input.artifactId)}`; }

/** Model summaries never contain raw signed facts or credentials. Signed bytes are never edited. */
function modelSafe(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[omitted]';
  if (typeof value === 'string') return value.replace(/\b(?:pat_[A-Za-z0-9_-]+|sk-swfte-[A-Za-z0-9_-]+|sk_[A-Za-z0-9_-]+|xox[a-z]-[A-Za-z0-9_-]+|Bearer\s+\S+)/gi, '[redacted]')
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, '[redacted]').slice(0, 16_384);
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => modelSafe(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [key,
    /authorization|api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|credential|private[-_]?key/i.test(key) ? '[redacted]' : modelSafe(item, depth + 1)]));
  return value;
}

/** Same restricted RFC8785 wire contract as the server; comparison also rejects duplicate JSON keys. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Non-interoperable proof number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode scalar');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Invalid Unicode scalar');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${canonical(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('Invalid proof JSON');
}
function canonicalJson(bytes: Uint8Array): unknown {
  if (!bytes.length || bytes.length > maxEnvelope) throw new Error('Invalid proof size');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const result: unknown = JSON.parse(text);
  if (canonical(result) !== text) throw new Error('Non-canonical proof JSON');
  return result;
}
function base64(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('Invalid proof encoding');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) throw new Error('Non-canonical proof encoding');
  return bytes;
}
function canonicalSignature(bytes: Buffer): boolean {
  const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) return false;
  let offset = 2;
  for (let index = 0; index < 2; index++) {
    if (bytes[offset++] !== 0x02) return false;
    const length = bytes[offset++];
    if (length === undefined || length < 1 || length > 33 || offset + length > bytes.length) return false;
    const first = bytes[offset]!;
    if (first >= 0x80 || (length > 1 && first === 0 && bytes[offset + 1]! < 0x80)) return false;
    const scalar = BigInt(`0x${bytes.subarray(offset, offset + length).toString('hex')}`);
    if (scalar <= 0n || scalar >= order || (index === 1 && scalar > order / 2n)) return false;
    offset += length;
  }
  return offset === bytes.length;
}

/** Frozen server wire is a single SPKI PUBLIC KEY, never a private key from which to derive one. */
function verificationKey(value: unknown) {
  if (typeof value !== 'string' || value.length > 16_384 || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) throw new Error('Invalid public verification key');
  const pem = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PUBLIC KEY-----\r?\n?$/.exec(value);
  if (!pem) throw new Error('Unsupported public verification key format');
  const encoded = pem[1]!.replace(/\r?\n/g, ''), der = Buffer.from(encoded, 'base64');
  if (!der.length || der.toString('base64') !== encoded) throw new Error('Invalid public key encoding');
  const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || !Buffer.from(key.export({ type: 'spki', format: 'der' })).equals(der)) throw new Error('Invalid public verification key');
  return key;
}

function envelope(bytes: Uint8Array, input: Subject, expectedWorkspace?: string): { predicate: JsonObject; keyId: string; signature: Buffer; payload: Buffer } {
  const root = canonicalJson(bytes);
  if (!object(root) || Object.keys(root).length !== 3 || root.payloadType !== payloadType || !Array.isArray(root.signatures) || root.signatures.length !== 1) throw new Error('Invalid DSSE envelope');
  const signature = root.signatures[0];
  if (!object(signature) || Object.keys(signature).length !== 2 || !hash.safeParse(signature.keyid).success) throw new Error('Invalid signature identity');
  const payload = base64(root.payload), signatureBytes = base64(signature.sig);
  if (!canonicalSignature(signatureBytes)) throw new Error('Non-canonical signature');
  const statement = canonicalJson(payload);
  if (!object(statement) || statement._type !== 'https://in-toto.io/Statement/v1' || statement.predicateType !== 'https://swfte.dev/proof-bundle/v1' || !Array.isArray(statement.subject) || statement.subject.length !== 1 || !object(statement.predicate)) throw new Error('Invalid proof statement');
  const subject = statement.subject[0], predicate = statement.predicate, artifact = predicate.artifact;
  if (!object(subject) || subject.name !== `${input.kind}:${input.artifactId}` || !object(subject.digest) || Object.keys(subject.digest).length !== 1 || subject.digest.sha256 !== input.contentHash.slice(7)
      || !object(artifact) || artifact.kind !== input.kind || artifact.id !== input.artifactId || artifact.contentHash !== input.contentHash || artifact.version !== 'content-hash'
      || typeof artifact.workspace !== 'string' || !artifact.workspace.trim() || (expectedWorkspace !== undefined && artifact.workspace !== expectedWorkspace)
      || !Number.isSafeInteger(predicate.assembledThroughLedgerSeq) || Number(predicate.assembledThroughLedgerSeq) < 0) throw new Error('Proof subject mismatch');
  for (const section of sections) {
    const value = predicate[section];
    if (Array.isArray(value) ? !value.length || !value.every(object) : !object(value) || value.status !== 'absent' || typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('Invalid proof section');
  }
  if (!object(predicate.contributors)) throw new Error('Invalid proof contributors');
  for (const contribution of Object.values(predicate.contributors)) {
    if (!object(contribution) || contribution.contentHash !== input.contentHash || !Number.isSafeInteger(contribution.assembledThroughLedgerSeq) || Number(contribution.assembledThroughLedgerSeq) < 0 || !object(contribution.facts)) throw new Error('Contributor subject mismatch');
  }
  return { predicate, keyId: String(signature.keyid), signature: signatureBytes, payload };
}

async function material(input: Subject, ctx: ToolContext, retainedVersion?: string) {
  const path = bundlePath(input);
  const selected = retainedVersion ? `${path}/versions/${encodeURIComponent(retainedVersion)}` : path;
  const binary = await ctx.client.getBinary(selected, { query: { hash: input.contentHash }, noStore: true, accept: 'application/json' });
  if (!/^application\/json(?:\s*;|$)/i.test(binary.contentType)) unavailable(selected);
  let parsed: ReturnType<typeof envelope>;
  try { parsed = envelope(binary.bytes, input, ctx.config.workspaceId); } catch { unavailable(selected, 'PROOF_BINDING_INVALID'); }
  const selectedVersion = retainedVersion ?? binary.headers['x-bundle-version'];
  if (!version.safeParse(selectedVersion).success) unavailable(selected);
  const signedVersion = (BigInt(Number(parsed.predicate.assembledThroughLedgerSeq)) + 1n).toString();
  if (selectedVersion !== signedVersion) unavailable(selected, 'PROOF_VERSION_BINDING_INVALID');
  const versions = await ctx.client.request<unknown>({ method: 'GET', headers: { 'Cache-Control': 'no-store' }, path: `${path}/versions`, query: { hash: input.contentHash }, retries: 0 });
  if (!Array.isArray(versions) || versions.length > 1000 || versions.some(item => !object(item) || !version.safeParse(item.bundleVersion).success || !hash.safeParse(item.keyId).success)
      || new Set(versions.map(item => item.bundleVersion)).size !== versions.length || !versions.some(item => item.bundleVersion === selectedVersion && item.keyId === parsed.keyId)) unavailable(`${path}/versions`);
  const key = await ctx.client.request<unknown>({ method: 'GET', headers: { 'Cache-Control': 'no-store' }, path: '/v2/proof-bundles/verification-key', query: { keyId: parsed.keyId }, retries: 0 });
  let publicPem: string;
  try {
    if (!object(key) || key.keyId !== parsed.keyId) throw new Error('Missing key');
    const publicKey = verificationKey(key.publicKey);
    if (`sha256:${digest(publicKey.export({ type: 'spki', format: 'der' }))}` !== parsed.keyId) throw new Error('Wrong key');
    publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pae = Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${parsed.payload.length} `), parsed.payload]);
    if (!verify('sha256', pae, publicKey, parsed.signature)) throw new Error('Signature invalid');
  } catch { unavailable(selected, 'PROOF_SIGNATURE_INVALID'); }
  return { bytes: binary.bytes, predicate: parsed.predicate, keyId: parsed.keyId, key: { keyId: parsed.keyId, publicKey: publicPem }, bundleVersion: selectedVersion as string,
    envelopeDigest: digest(binary.bytes), versions: versions as { bundleVersion: string; keyId: string }[] };
}

async function offlinePackage(input: Subject, ctx: ToolContext, bound: Awaited<ReturnType<typeof material>>) {
  const path = `${bundlePath(input)}/package`;
  const binary = await ctx.client.getBinary(path, { query: { hash: input.contentHash, version: bound.bundleVersion }, noStore: true, accept: 'application/zip' });
  try {
    if (!/^application\/zip(?:\s*;|$)/i.test(binary.contentType) || !binary.bytes.length || binary.bytes.length > maxPackage) throw new Error('Invalid package');
    const names = new Set<string>(), permitted = new Set(['envelope.json', 'subject.json', 'public.pem', 'VERIFY.txt']);
    let size = 0;
    const files = unzipSync(binary.bytes, { filter: file => {
      size += file.originalSize;
      if (!permitted.has(file.name) || names.has(file.name) || file.originalSize > maxEnvelope || size > maxPackage) throw new Error('Invalid package entry');
      names.add(file.name); return true;
    } });
    if (names.size !== 4 || !files['envelope.json'] || !files['subject.json'] || !files['public.pem'] || !files['VERIFY.txt']
        || !Buffer.from(files['envelope.json']).equals(Buffer.from(bound.bytes)) || digest(files['subject.json']) !== input.contentHash.slice(7)
        || new TextDecoder('utf-8', { fatal: true }).decode(files['VERIFY.txt']).trim() !== verifyCommand) throw new Error('Package subject mismatch');
    const publicKey = verificationKey(new TextDecoder('utf-8', { fatal: true }).decode(files['public.pem']));
    if (`sha256:${digest(publicKey.export({ type: 'spki', format: 'der' }))}` !== bound.keyId) throw new Error('Package key mismatch');
    return { filename: 'proof-bundle.zip', contentType: 'application/zip', encoding: 'base64', bytes: Buffer.from(binary.bytes).toString('base64'), sha256: digest(binary.bytes), byteLength: binary.bytes.length };
  } catch { unavailable(path, 'PROOF_PACKAGE_BINDING_INVALID'); }
}

/** Coordinator-frozen exact-packet-link-v1; the existing page is not the full new room. */
function packetHref(actionId: string, kind: string, artifactId: string, contentHash: string): string {
  const url = new URL(process.env.SWFTE_STUDIO_URL ?? 'https://studio.swfte.com');
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid Studio URL');
  url.pathname = `/v2/studio/review/${encodeURIComponent(kind)}/${encodeURIComponent(artifactId)}`;
  url.searchParams.set('action', actionId); url.searchParams.set('hash', contentHash); return url.toString();
}

/** Mandatory currentness projection from54744976d; archive presence alone grants no authority. */
function currentRoomBinding(room: JsonObject, requestedHash: string): boolean {
  const action = room.action;
  if (!object(action) || typeof action.capability !== 'string' || !action.capability.trim()) return false;
  const planRequired = action.planHash !== null || action.capability.startsWith('release.');
  const currentContentValid = action.currentContentStatus === 'available'
    ? hash.safeParse(action.currentContentHash).success
    : action.currentContentStatus === 'dependency_unavailable' && action.currentContentHash === null;
  const currentPlanValid = planRequired
    ? action.currentPlanStatus === 'available'
      ? hash.safeParse(action.currentPlanHash).success
      : action.currentPlanStatus === 'dependency_unavailable' && action.currentPlanHash === null
    : action.currentPlanStatus === 'not_applicable' && action.currentPlanHash === null;
  const missingDecisionEvidence = action.currentContentStatus !== 'available'
    || (planRequired && (action.currentPlanStatus !== 'available' || action.planHash === null)) || room.packet === null;
  const hasDependency = typeof action.decisionDependency === 'string' && action.decisionDependency.trim().length > 0;
  const expectedStale = action.contentHash !== requestedHash
    || (action.currentContentStatus === 'available' && action.currentContentHash !== action.contentHash)
    || (action.planHash !== null && action.currentPlanStatus === 'available' && action.currentPlanHash !== action.planHash);
  return currentContentValid && currentPlanValid && action.packetStatus === (room.packet === null ? 'absent' : 'available')
    && (missingDecisionEvidence ? hasDependency : action.decisionDependency === null || hasDependency)
    && room.stale === expectedStale
    && (room.stale ? typeof room.staleReason === 'string' && room.staleReason.trim().length > 0 : room.staleReason === null);
}

async function boundRoom(input: { actionId: string; contentHash: string }, ctx: ToolContext): Promise<JsonObject & { action: JsonObject }> {
  const path = `/v2/review/${encodeURIComponent(input.actionId)}`;
  const room = await ctx.client.request<unknown>({ method: 'GET', path, query: { hash: input.contentHash }, headers: { 'Cache-Control': 'no-store' }, retries: 0 });
  if (!object(room) || room.contentHash !== input.contentHash || !object(room.action) || room.action.id !== input.actionId
      || !REVIEW_KINDS.includes(room.action.kind as typeof REVIEW_KINDS[number]) || !identity.safeParse(room.action.artifactId).success
      || !hash.safeParse(room.action.contentHash).success || (room.action.planHash !== null && !hash.safeParse(room.action.planHash).success)
      || typeof room.stale !== 'boolean' || (room.action.contentHash !== input.contentHash && room.stale !== true)
      || !Array.isArray(room.reports) || room.reports.length !== roomReportKeys.length
      || room.reports.some((report, index) => !object(report) || report.key !== roomReportKeys[index] || report.contentHash !== input.contentHash
        || (typeof report.status !== 'string' || !['available', 'absent', 'dependency_unavailable'].includes(report.status)) || !object(report.facts)
        || (report.status === 'available' ? report.reason !== null : typeof report.reason !== 'string' || !report.reason.trim()))
      || typeof room.proofSuiteAvailable !== 'boolean' || !object(room.reviewRequirements)
      || typeof room.reviewRequirements.noteRequired !== 'boolean' || typeof room.reviewRequirements.highRiskAcknowledgementRequired !== 'boolean'
      || typeof room.reviewRequirements.dealbreakerHit !== 'boolean' || !Array.isArray(room.reviewRequirements.unrunHighRiskScenarios)
      || room.reviewRequirements.unrunHighRiskScenarios.some(id => typeof id !== 'string')
      || (room.packet !== null && (!object(room.packet) || room.packet.contentHash !== input.contentHash || room.packet.kind !== room.action.kind || room.packet.id !== room.action.artifactId))
      || !currentRoomBinding(room, input.contentHash)) unavailable(path, 'REVIEW_ROOM_BINDING_INVALID');
  return room as JsonObject & { action: JsonObject };
}

/** Server GETs can persist archive/bundle evidence. MCP never writes human view/decision facts. */
export const reviewTools: ToolDefinition[] = [
  {
    name: 'swfte_open_review_room', title: 'Open an exact review room', group: 'core', readOnly: false,
    description: 'Return bound exact-hash archived server state and the existing Studio exact packet-view link. This is not a full nine-tab room or proof that a human read it. GET may archive evidence; no human view, run, mark or decision is recorded. Missing historical evidence and unavailable runtimes remain explicit.',
    inputSchema: z.object({ actionId: actionIdentity, contentHash: hash }).strict(),
    execute: async (input, ctx) => {
      const room = await boundRoom(input, ctx);
      // Construct only after the action, packet and every report have passed the exact binding checks.
      const url = packetHref(input.actionId, String(room.action.kind), String(room.action.artifactId), input.contentHash);
      return { actionId: input.actionId, contentHash: input.contentHash, url, linkKind: 'exact-packet', fullReviewRoomAvailable: false,
        humanViewRecorded: false, room: modelSafe(room) };
    },
  },
  {
    name: 'swfte_assemble_proof_bundle', title: 'Assemble signed proof evidence', group: 'core', readOnly: false,
    description: 'Assemble current exact-hash evidence or read an exact retained version for any original artifact kind. Return bound version/key/digest and explicit section absences. Optional offlinePackage returns the unchanged confidentiality-scanned ZIP. GET can persist evidence, so it is never automatically retried. Native signature checking does not claim an independent cosign or runtime gate.',
    inputSchema: z.object({ ...subjectInput, bundleVersion: version.optional(), offlinePackage: z.boolean().optional() }).strict(),
    execute: async (input, ctx) => {
      const bound = await material(input, ctx, input.bundleVersion);
      const presence = Object.fromEntries(sections.map(section => [section, Array.isArray(bound.predicate[section])
        ? { status: 'available', records: (bound.predicate[section] as unknown[]).length }
        : modelSafe(bound.predicate[section])]));
      return { kind: input.kind, artifactId: input.artifactId, contentHash: input.contentHash, workspaceId: (bound.predicate.artifact as JsonObject).workspace,
        bundleVersion: bound.bundleVersion, keyId: bound.keyId, envelopeDigest: bound.envelopeDigest, sections: presence, retainedVersions: bound.versions,
        verification: { signatureVerified: true, algorithm: 'ECDSA-P256-SHA256', keyTrust: 'Authenticated Swfte verification-key API', independentCosignVerified: false, command: verifyCommand, publicKey: bound.key.publicKey },
        material: { envelopePath: `${bundlePath(input)}/versions/${encodeURIComponent(bound.bundleVersion)}`, query: { hash: input.contentHash }, packagePath: `${bundlePath(input)}/package`, packageQuery: { hash: input.contentHash, version: bound.bundleVersion } },
        ...(input.offlinePackage ? { offlinePackage: await offlinePackage(input, ctx, bound) } : {}) };
    },
  },
  {
    name: 'swfte_export_proof_bundle', title: 'Export exact audit evidence', group: 'core', readOnly: false,
    description: 'Ask the existing admin-authorized server export rail to submit the current exact-hash signed bundle to a configured audit platform/document. One POST, no automatic retry. Confirm its receipt against the actual retained original envelope bytes. An unavailable confirmation or unknown effect requires owner reconciliation; it never grants approval authority.',
    inputSchema: z.object({ ...subjectInput, platform: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), documentId: identity }).strict(),
    execute: async (input, ctx) => {
      const path = `${bundlePath(input)}/export`;
      const receipt = await ctx.client.request<unknown>({ method: 'POST', path, body: { contentHash: input.contentHash, platform: input.platform, documentId: input.documentId }, retries: 0 });
      const prefix = `${input.contentHash}:`;
      if (!object(receipt) || receipt.platform !== input.platform || receipt.documentId !== input.documentId || receipt.status !== 'submitted'
          || typeof receipt.uploadReference !== 'string' || !receipt.uploadReference.trim() || typeof receipt.envelopeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.envelopeDigest)
          || typeof receipt.idempotencyKey !== 'string' || !receipt.idempotencyKey.startsWith(prefix) || !version.safeParse(receipt.idempotencyKey.slice(prefix.length)).success) {
        throw new SwfteApiError({ status: 503, code: 'PROOF_EXPORT_RECEIPT_MISMATCH', message: 'Export outcome is unconfirmed. Reconcile the existing server export before retrying.', method: 'POST', path });
      }
      const bundleVersion = receipt.idempotencyKey.slice(prefix.length);
      try {
        const bound = await material(input, ctx, bundleVersion);
        if (bound.envelopeDigest !== receipt.envelopeDigest) throw new Error('Receipt digest mismatch');
        return { receipt: modelSafe(receipt), contentHash: input.contentHash, bundleVersion, envelopeDigest: bound.envelopeDigest, signatureVerified: true, independentCosignVerified: false };
      } catch (failure) {
        throw new SwfteApiError({ status: 503, code: 'PROOF_EXPORT_CONFIRMATION_UNAVAILABLE', message: 'The export may have committed, but its exact envelope cannot be confirmed. Reconcile this receipt before retrying.', method: 'POST', path,
          envelope: { receipt: modelSafe(receipt), bundleVersion, confirmation: failure instanceof SwfteApiError ? { code: failure.code, status: failure.status } : { code: 'PROOF_BINDING_INVALID' } } });
      }
    },
  },
  {
    name: 'swfte_review_room', title: 'Read a review room', group: 'extras', readOnly: false,
    description: 'Compatibility alias: read the archived room for an exact hash. GET may archive evidence; it creates no human view or decision. Prefer swfte_open_review_room for bound state and explicit Studio link availability.',
    inputSchema: z.object({ actionId: actionIdentity, contentHash: hash }).strict(),
    execute: async (input, ctx) => modelSafe(await boundRoom(input, ctx)),
  },
  {
    name: 'swfte_proof_bundle', title: 'Read signed proof bundle', group: 'extras', readOnly: false,
    description: 'Compatibility alias: read a signed exact-hash envelope for any original kind. GET may assemble/persist evidence; it is never automatically retried. Prefer swfte_assemble_proof_bundle for version/key/subject checking and offline material.',
    inputSchema: z.object(subjectInput).strict(),
    execute: async (input, ctx) => { const bound = await material(input, ctx); return modelSafe(canonicalJson(bound.bytes)); },
  },
];
