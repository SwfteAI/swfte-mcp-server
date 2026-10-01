import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSourceFile, sha256, treeKey } from './treekey.js';
import type { ProofCheck, ProofFinding, TreeSnapshot } from './types.js';

const exec = promisify(execFile);
const PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu],
  ['uri-credentials', /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9+.\-]{1,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,128}@/gu],
  ['aws-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{12,}\b/gu],
  ['bearer', /\bBearer\s+[A-Za-z0-9._\-]{10,}/gu],
  ['provider-token', /(?<![A-Za-z0-9])(?:sk-(?:ant-)?[A-Za-z0-9_\-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glp(?:at|tt)-[A-Za-z0-9_\-]{16,}|npm_[A-Za-z0-9]{16,}|dop_v1_[A-Za-z0-9]{32,}|xox[baprse]-[A-Za-z0-9\-]{10,}|xapp-[0-9]-[A-Za-z0-9\-]{10,}|AIza[A-Za-z0-9_\-]{30,}|ya29\.[A-Za-z0-9_\-]{20,}|(?:AC|SK)[a-z0-9]{32}|shp(?:at|ss)_[A-Za-z0-9]{20,})/gu],
  ['assignment', /(?:pass(?:word|wd)?|pwd|secret|token|credentials?|auth[_-]?token|access[_-]?token|refresh[_-]?token|(?:api[_-]?|access[_-]?|private[_-]?|secret[_-]?|client[_-]?)?key|client[_-]?secret|priv[_-]?key)['"]?\s*[:=]\s*['"]?[^\s'"]{4,}/giu],
  ['jwt', /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/gu],
  ['long-secret', /(?<![A-Za-z0-9/+])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9/+])/gu],
  ['hex-token', /(?<![A-Za-z0-9])[0-9a-fA-F]{20,}(?![A-Za-z0-9])/gu],
];
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((total, count) => total - count / value.length * Math.log2(count / value.length), 0);
}
function secretEntropy(token: string): boolean {
  if (/^[A-Za-z]{28,}$/u.test(token)) return entropy(token) >= 4.1;
  if (!/[a-z]/iu.test(token) || !/[0-9]/u.test(token)) return false;
  const core = token.replace(/[._\-/+=]/gu, '');
  if (core.length < 16) return false;
  const bits = entropy(core);
  if (/^(?:[\w-]+\.)+[\w-]+$|^(?:\/?[\w.-]+\/)+[\w.-]*$/u.test(token) && bits < 3.9) return false;
  return bits >= 3.6;
}

/** Refusal findings carry only path/line/category; never a secret, excerpt, command output or match. */
export function secretFindings(path: string, content: string): ProofFinding[] {
  const findings: ProofFinding[] = [];
  const add = (kind: string, offset: number): void => {
    const line = content.slice(0, offset).split('\n').length;
    if (findings.some(finding => finding.line === line && finding.rule_id === kind)) return;
    findings.push({ rule_id: kind, severity: 'CRITICAL', file: path, line,
      message: 'Credential-shaped source detected; upload refused.',
      remediation: 'Remove the credential, rotate it if live, and load it through a secret broker.' });
  };
  for (const [kind, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) { add(kind, match.index); if (findings.length >= 300) return findings; }
  }
  for (const match of content.matchAll(/[A-Za-z0-9_\-+/=.]{20,}/gu)) {
    if (secretEntropy(match[0])) add('entropy', match.index);
    if (findings.length >= 300) break;
  }
  return findings;
}

export async function inspectSource(snapshot: TreeSnapshot): Promise<ProofFinding[]> {
  const findings: ProofFinding[] = [];
  for (const file of snapshot.manifest.files) {
    const bytes = await readSourceFile(snapshot.root, file.path);
    if (sha256(bytes) !== file.sha256) throw new Error('STALE_CONTENT: source changed during local scan');
    findings.push(...secretFindings(file.path, Buffer.from(bytes).toString('utf8')));
  }
  return findings;
}

export interface LocalProof {
  snapshot: TreeSnapshot; verdict: 'FAIL' | 'PARTIAL'; checks: ProofCheck[]; findings: ProofFinding[];
}
/** Checks are fixed read-only commands; repository npm scripts or supplied shell commands never run. */
export async function runLocal(path: string, requested: string[] = ['scan', 'deps']): Promise<LocalProof> {
  if (requested.some(check => !['build', 'test', 'scan', 'data', 'traffic', 'attack', 'deps'].includes(check))) {
    throw new Error('Unknown local check');
  }
  const snapshot = await treeKey(path); const findings = await inspectSource(snapshot); const checks: ProofCheck[] = [];
  if (requested.includes('scan')) checks.push({ name: 'scan', ok: findings.length === 0,
    detail: findings.length ? 'Source secret detected; upload refused' : 'No credential pattern matched; static safety remains untested' });
  if (requested.includes('deps')) {
    let checked = 0; let unknown = 0; const licenses: ProofFinding[] = [];
    for (const file of snapshot.manifest.files.filter(file => /(?:^|\/)package(?:-lock)?\.json$/u.test(file.path))) {
      const bytes = await readSourceFile(snapshot.root, file.path);
      if (sha256(bytes) !== file.sha256) throw new Error('STALE_CONTENT');
      let manifest: Record<string, unknown>;
      try { manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>; }
      catch { unknown++; continue; }
      const records = [manifest, ...Object.values((manifest.packages ?? {}) as Record<string, Record<string, unknown>>)];
      for (const record of records) {
        checked++;
        if (typeof record.license !== 'string') { unknown++; continue; }
        if (/\b(?:BUSL|BSL|ELv2|Elastic-2\.0|AGPL|GPL|LGPL|MPL|EPL|CDDL)\b/iu.test(record.license)) {
          licenses.push({ rule_id: 'license-refused', severity: 'HIGH', file: file.path, line: 1,
            message: 'A source manifest declares a prohibited or undeclared copyleft license.',
            remediation: 'Resolve the license boundary before importing or executing this source.' });
        }
      }
    }
    findings.push(...licenses);
    checks.push({ name: 'deps', ok: licenses.length ? false : null,
      detail: `Inspected ${checked} manifest entries; ${unknown} licenses unknown. Advisory cache and complete dependency licenses are unavailable.` });
  }
  try {
    await exec('git', ['-C', snapshot.root, 'diff', '--no-ext-diff', '--no-textconv', '--check'], { timeout: 10_000, maxBuffer: 100_000 });
    checks.push({ name: 'local-diff', ok: true, detail: 'Git diff whitespace check exited zero' });
  } catch { checks.push({ name: 'local-diff', ok: false, detail: 'Git diff check failed or is unavailable' }); }
  for (const check of requested.filter(check => !['scan', 'deps'].includes(check))) {
    checks.push({ name: check, ok: null, detail: 'Not run: local commands require an independent user-approved check runner' });
  }
  return { snapshot, verdict: checks.some(check => check.ok === false) ? 'FAIL' : 'PARTIAL', checks, findings };
}
