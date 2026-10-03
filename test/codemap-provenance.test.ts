import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordWrittenFiles, provenanceForSites } from '../src/codemap/provenance.js';
import { assigned, project } from './codemap-support.js';

test('write receipts attribute new committed files only and invalidate on later edits', () => {
  const root = project({ 'package.json': '{"name":"fixture"}' });
  const source = "client.workflows.invoke('wf_a', {});\n";
  writeFileSync(join(root, 'new.ts'), source); writeFileSync(join(root, 'old.ts'), source);
  try {
    recordWrittenFiles(root, [{ path: 'new.ts', action: 'create', bytes: source.length }, { path: 'old.ts', action: 'overwrite', bytes: source.length }], 'codex', 'mcp', 12);
    const provenance = provenanceForSites(root, [assigned('new.ts'), { ...assigned('old.ts'), id: 'cs_' + '2'.repeat(24) }]);
    assert.equal(provenance.size, 1); assert.equal(provenance.values().next().value?.addedBy, 'codex');
    writeFileSync(join(root, 'new.ts'), source + '// human edit\n');
    assert.equal(provenanceForSites(root, [assigned('new.ts')]).size, 0);
    assert.throws(() => recordWrittenFiles(root, [{ path: '../../escape', action: 'create', bytes: 1 }], 'codex', 'mcp'), /confine|outside|escape|relative/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
