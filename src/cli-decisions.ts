/** Driver dispatch: `runDecisionsCli(argv.slice(1), io)` for `swfte decisions ...`. */
import { resolve } from 'node:path';
import type { CliIO } from './cli.js';
import { SwfteClient } from './client.js';
import { importBatches, NexusIngestError, previewNexus, readNexus } from './nexus-ingest.js';
import { applyNexus } from './tools/decisions.js';

export const DECISIONS_USAGE = `swfte decisions ingest [--from <project-dir>] [--repo <exact-slug>] [--ref <kind:id>] [--apply] [--json] [--cwd <project-dir>]
Default --from is the real ~/.nexus directory. Other data roots stay inside the project.
Preview reads bounded local data and makes zero HTTP calls; --apply imports private PROPOSED decisions.`;
export type DecisionCliIO = CliIO & { localFilesystem?: boolean };
export type DecisionClientFactory = () => SwfteClient | Promise<SwfteClient>;

function parse(argv: string[]) {
  const args = argv[0] === 'decisions' ? argv.slice(1) : [...argv];
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return { help: true as const };
  if (args.shift() !== 'ingest') throw new NexusIngestError('USAGE', 'Use swfte decisions ingest.');
  const values: Record<string, string> = {};
  let apply = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return { help: true as const };
    if (arg === '--apply') { if (apply) throw new NexusIngestError('USAGE', 'Duplicate apply flag.'); apply = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (!['--from', '--repo', '--ref', '--cwd'].includes(arg) || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      throw new NexusIngestError('USAGE', 'Unknown argument or missing flag value.');
    }
    const key = arg.slice(2);
    if (values[key] !== undefined) throw new NexusIngestError('USAGE', 'Duplicate value flag.');
    values[key] = args[++i]!;
  }
  return { help: false as const, apply, json, values };
}

/** No config, credential setup or client factory invocation until a nonempty explicit apply. */
export async function runDecisionsCli(argv: string[], io: DecisionCliIO, createClient?: DecisionClientFactory): Promise<number> {
  try {
    const parsed = parse(argv);
    if (parsed.help) { io.out(DECISIONS_USAGE); return 0; }
    const read = readNexus({ from: parsed.values.from, repo: parsed.values.repo, ref: parsed.values.ref,
      cwd: resolve(io.cwd, parsed.values.cwd ?? '.'), localFilesystem: io.localFilesystem });
    let report: ReturnType<typeof previewNexus> | Awaited<ReturnType<typeof applyNexus>>;
    if (!parsed.apply) report = previewNexus(read);
    else if (importBatches(read.decisions).length === 0) report = { ...previewNexus(read), dryRun: false,
      created: 0, duplicates: 0, rejected: [], submitted: 0, requests: 0, remaining: 0,
      note: 'No matched decisions to import; no HTTP calls were made.' };
    else {
      const factory = createClient ?? (async () => {
        const { cliConfig } = await import('./cli.js');
        return new SwfteClient(cliConfig(io.env)); // trusted env URL; never swfte.json's arbitrary host
      });
      report = await applyNexus(read, await factory());
    }
    if (parsed.json) io.out(JSON.stringify(report));
    else {
      io.out(`${report.dryRun ? 'Preview' : 'Import'}: ${report.proposed} proposed, ${report.inspected} inspected${report.truncated ? ', input capped' : ''}.`);
      for (const candidate of report.candidates) io.out(`${candidate.catalogRef} ${candidate.sourceType} ${candidate.externalId} PROPOSED`);
      if (report.candidatesOmitted) io.out(`${report.candidatesOmitted} additional candidate ids omitted from this bounded preview.`);
      for (const item of report.skippedItems) io.out(`Skipped ${item.code}: ${item.sourceType} ${item.externalId}.`);
      if (report.skippedItemsOmitted) io.out(`${report.skippedItemsOmitted} additional skipped ids omitted from this bounded preview.`);
      for (const [code, count] of Object.entries(report.skipped)) io.out(`Skipped ${code}: ${count}.`);
      if ('created' in report) io.out(`Created ${report.created}, duplicates ${report.duplicates}, rejected ${report.rejected.length}.`);
      io.out(report.note);
    }
    return 'error' in report || ('rejected' in report && report.rejected.length > 0) ? 1 : 0;
  } catch (error) {
    const codes = new Set(['USAGE', 'PATH_REFUSED', 'LOCK_REFUSED', 'READ_FAILED', 'INVALID_REF', 'INVALID_REPO', 'ITEM_TOO_LARGE', 'INVALID_IMPORT']);
    const code = error instanceof NexusIngestError && codes.has(error.code) ? error.code : 'DECISIONS_FAILED';
    // Never print filesystem paths, source text, credential/config errors or server envelopes.
    io.err(`Decision ingest refused (${code}).${code === 'USAGE' ? `\n${DECISIONS_USAGE}` : ''}`);
    return 1;
  }
}
