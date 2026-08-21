#!/usr/bin/env npx tsx
/**
 * Mint a PAT directly into a LOCAL DynamoDB, for local end-to-end testing.
 *
 * The normal way to get a token is the Studio UI, which mints via
 * `POST /v1/personal-access-tokens` using your logged-in session. That needs a
 * browser. When you are running agents-service locally against DynamoDB Local,
 * this writes the same row the service would write, so the local stack can be
 * exercised end to end without a browser round-trip.
 *
 * It reproduces `PersonalAccessTokenService.issue` exactly:
 *   - 32 random bytes, base64url, prefixed `pat_`
 *   - only the SHA-256 hex digest and a 12-char display prefix are stored
 *   - status "active" (the check is case-insensitive equality on that string)
 *
 * REFUSES to run against anything but localhost. Writing an auth row into a
 * shared or production table would be creating a credential out of band, which
 * is exactly the thing the real mint flow exists to prevent.
 *
 *   npx tsx scripts/mint-local-pat.ts
 *   npx tsx scripts/mint-local-pat.ts --workspace 316 --user user_abc --name "mcp e2e"
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (n: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const DDB = arg('endpoint', process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000')!;
const TABLE = arg('table', 'PersonalAccessToken')!;
const WORKSPACE = arg('workspace', '316')!;
const USER = arg('user', 'user_01KR725MR8WC60KETFG0XMFF8H')!;
const ACCOUNT = arg('account', '1')!;
const NAME = arg('name', 'mcp-local-e2e')!;
const DAYS = Number(arg('days', '7'));

// Hard guard. A local-only tool that can be pointed at prod is not a local-only tool.
const host = new URL(DDB).hostname;
if (!['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) {
  console.error(
    `Refusing to write an auth row to a non-local DynamoDB (${host}).\n` +
      'This script exists for local testing only. To get a real token, mint it through Studio.'
  );
  process.exit(1);
}

async function ddb(target: string, body: unknown): Promise<any> {
  const res = await fetch(DDB, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': `DynamoDB_20120810.${target}`,
      // DynamoDB Local accepts any credential shape.
      Authorization: 'AWS4-HMAC-SHA256 Credential=local/20260101/eu-west-1/dynamodb/aws4_request',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DynamoDB ${target} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function main(): Promise<void> {
  // Fail early with a clear message rather than a cryptic ValidationException.
  await ddb('DescribeTable', { TableName: TABLE }).catch(() => {
    throw new Error(
      `Table "${TABLE}" not found at ${DDB}. Is agents-service running against DynamoDB Local?`
    );
  });

  const raw = `pat_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + DAYS * 86_400_000);

  const item = {
    id: { S: randomUUID() },
    token_hash: { S: hash },
    token_prefix: { S: raw.slice(0, 12) },
    name: { S: NAME },
    user_id: { S: USER },
    workspace_id: { S: WORKSPACE },
    account_id: { S: ACCOUNT },
    // Case-insensitive "active" is what isUsable() checks for.
    status: { S: 'active' },
    created_at_iso: { S: now.toISOString() },
    expires_at_iso: { S: expires.toISOString() },
  };

  await ddb('PutItem', { TableName: TABLE, Item: item });

  console.log(`minted local PAT for workspace=${WORKSPACE} user=${USER}`);
  console.log(`expires ${expires.toISOString()} (${DAYS}d)\n`);
  console.log(raw);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
