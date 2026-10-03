/** Explicit tagging uses parser spans, plans every write first and refuses ambiguous shapes. */
import ts from 'typescript';
import { ConfinedWriter } from '../fsguard.js';
import { readConfined } from './walk.js';
import { withTree as rawPythonTree, walk as walkPython } from './detectors/py/parse.js';
import { withTree as rawJavaTree, walk as walkJava, argsOf, nameOf } from './detectors/java/parse.js';
import type { AssignedSite } from './fingerprint.js';

interface Edit { start: number; end: number; text: string }

/**
 * `withTree` returns null when a grammar is unavailable, but it also swallows anything the callback throws.
 * Tagging planners refuse unsafe shapes by throwing, so capture that refusal and rethrow it past `withTree`;
 * otherwise a real "Unknown Java native overload" refusal would read as "grammar unavailable".
 */
function refusing<N>(run: <T>(text: string, fn: (root: N) => T) => T | null): <T>(text: string, fn: (root: N) => T) => T | null {
  return <T>(text: string, fn: (root: N) => T): T | null => {
    let refusal: { error: unknown } | undefined;
    const out = run(text, (root) => {
      try { return fn(root); } catch (error) { refusal = { error }; return undefined as unknown as T; }
    });
    if (refusal) throw refusal.error;
    return out;
  };
}
const pythonTree = refusing(rawPythonTree);
const javaTree = refusing(rawJavaTree);
const methods = new Set(['invoke', 'invokeAndWait', 'invokeVersion', 'invokeVersionAndWait', 'execute', 'chat', 'startSession', 'test']);
const tsLine = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function optionsEdit(text: string, node: ts.Expression | undefined, insertAt: number, missing: number, id: string, legacyBoolean = false): Edit {
  const property = `callsite: '${id}'`;
  if (!node) return { start: insertAt, end: insertAt, text: `${', undefined'.repeat(missing)}, { ${property} }` };
  if (ts.isObjectLiteralExpression(node)) {
    const existing = node.properties.find(p => p.name && p.name.getText().replace(/['"]/g, '') === 'callsite');
    if (existing) {
      if (!ts.isPropertyAssignment(existing)) throw new Error('Cannot replace an opaque callsite property.');
      return { start: existing.initializer.getStart(), end: existing.initializer.end, text: `'${id}'` };
    }
    const interior = text.slice(node.getStart() + 1, node.end - 1).trimEnd();
    return { start: node.end - 1, end: node.end - 1, text: `${node.properties.length && !interior.endsWith(',') ? ', ' : ''}${property}` };
  }
  if (legacyBoolean && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) {
    return { start: node.getStart(), end: node.end, text: `{ skipValidation: ${node.getText()}, ${property} }` };
  }
  if (node.kind === ts.SyntaxKind.NullKeyword || node.getText() === 'undefined') {
    return { start: node.getStart(), end: node.end, text: `{ ${property} }` };
  }
  // Spreading preserves evaluation once and caller settings, with the explicit tag last.
  return { start: node.getStart(), end: node.end, text: `{ ...(${text.slice(node.getStart(), node.end)}), ${property} }` };
}

function tsEdits(path: string, text: string, sites: AssignedSite[]): Edit[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    /\.[cm]?jsx?$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, visit); };
  visit(sf);
  return sites.map(({ site, id }) => {
    const candidates = calls.filter(call => {
      if (tsLine(sf, call) !== site.line) return false;
      const callee = call.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      return site.artifact.alias ? /^(invoke|chat)[A-Z0-9_]/.test(name) : methods.has(name);
    });
    if (site.managed !== 'typed-client' || candidates.length !== 1) throw new Error(`Tagging requires one supported SDK call at ${path}:${site.line}.`);
    const call = candidates[0]!;
    const callee = call.expression;
    const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (call.arguments.length === 0) throw new Error('Tagging refuses an SDK call without its required artifact argument.');
    const index = site.artifact.alias ? 1 : method === 'invokeVersion' || method === 'invokeVersionAndWait' ? 3 : 2;
    if (call.arguments.length > index + 1) throw new Error(`Unknown SDK overload at ${path}:${site.line}.`);
    return optionsEdit(text, call.arguments[index], call.end - 1, Math.max(0, index - call.arguments.length), id, method === 'execute');
  });
}

function pyEdits(path: string, text: string, sites: AssignedSite[]): Edit[] {
  const edits = pythonTree(text, root => sites.map(({ site, id }) => {
    const matches: typeof root[] = [];
    walkPython(root, node => {
      if (node.type === 'call' && node.startPosition.row + 1 === site.line) {
        const name = node.childForFieldName('function')?.text.split('.').pop() ?? '';
        if (site.artifact.alias ? /^(invoke|chat)_/.test(name) : ['invoke', 'invoke_and_wait', 'invoke_version', 'invoke_version_and_wait', 'execute', 'chat', 'start_session', 'test'].includes(name)) matches.push(node);
      }
    });
    if (site.managed !== 'typed-client' || matches.length !== 1) throw new Error(`Tagging requires one supported SDK call at ${path}:${site.line}.`);
    const args = matches[0]!.childForFieldName('arguments');
    if (!args) throw new Error('Missing Python argument span.');
    const existing = args.namedChildren.find(n => n && n.type === 'keyword_argument' && n.childForFieldName('name')?.text === 'callsite');
    if (existing) {
      const value = existing.childForFieldName('value')!;
      return { start: value.startIndex, end: value.endIndex, text: `'${id}'` };
    }
    const end = args.endIndex - 1;
    const trailing = text.slice(args.startIndex + 1, end).trimEnd();
    return { start: end, end, text: `${trailing && !trailing.endsWith(',') ? ', ' : ''}callsite='${id}'` };
  }));
  if (!edits) throw new Error('Python grammar unavailable; no source was changed.');
  return edits;
}

function jEdits(path: string, text: string, sites: AssignedSite[]): Edit[] {
  const edits = javaTree(text, root => sites.map(({ site, id }) => {
    const matches: typeof root[] = [];
    walkJava(root, node => { if (node.type === 'method_invocation' && node.startPosition.row + 1 === site.line && methods.has(nameOf(node))) matches.push(node); });
    if (site.managed !== 'typed-client' || matches.length !== 1) throw new Error(`Tagging requires one supported SDK call at ${path}:${site.line}.`);
    const call = matches[0]!;
    const args = argsOf(call);
    const tag = `com.swfte.sdk.CallSite.of("${id}")`;
    const explicitTag = (text: string) => /^(?:com\.swfte\.sdk\.)?CallSite\.of\(/.test(text);
    const name = nameOf(call);
    if (name === 'startSession') {
      const receiver = call.childForFieldName('object');
      if (!receiver || receiver.type !== 'method_invocation' || nameOf(receiver) !== 'chatflows'
        || argsOf(receiver).length !== 0 || !receiver.childForFieldName('object')) {
        throw new Error('Unknown Java session receiver.');
      }
      if (!((args.length === 2 && !args.some(arg => explicitTag(arg.text)))
        || (args.length === 3 && explicitTag(args[2]!.text)
          && !args.slice(0, 2).some(arg => explicitTag(arg.text))))) {
        throw new Error('Unknown Java session overload.');
      }
    }
    const receiver = call.childForFieldName('object');
    let resource = receiver && receiver.type === 'method_invocation' && argsOf(receiver).length === 0
      && receiver.childForFieldName('object') ? nameOf(receiver) : '';
    if (name === 'test') {
      const owner = receiver?.childForFieldName('object');
      resource = resource === 'builder' && owner?.type === 'method_invocation' && nameOf(owner) === 'chatflows'
        && argsOf(owner).length === 0 && owner.childForFieldName('object') ? 'chatflows' : '';
    }
    const expected = name === 'chat' ? ['agents', 'agent']
      : name === 'test' || name === 'startSession' ? ['chatflows', 'chatflow'] : ['workflows', 'workflow'];
    if (resource !== expected[0] || site.artifact.kind !== expected[1]) throw new Error('Unknown Java SDK receiver.');
    // Native overloads are admitted before the existing-tag shortcut. A tag in the ID,
    // inputs, options or timing arguments cannot manufacture a valid final overload.
    const plain: Record<string, number[]> = {
      invoke: [2], invokeVersion: [3], invokeAndWait: [2, 4, 5], invokeVersionAndWait: [3, 6],
      execute: [2, 3], chat: [2, 3], test: [2], startSession: [2],
    };
    const tagged: Record<string, number[]> = {
      invoke: [3], invokeVersion: [4], invokeAndWait: [3, 5, 6], invokeVersionAndWait: [4, 7],
      execute: [3, 4], chat: [4], test: [3], startSession: [3],
    };
    const tags = args.filter(arg => explicitTag(arg.text));
    if (tags.length ? tags.length !== 1 || tags[0] !== args.at(-1) || !tagged[name]?.includes(args.length)
      : !plain[name]?.includes(args.length)) throw new Error('Unknown Java native overload.');
    const existing = tags[0];
    if (existing) return { start: existing.startIndex, end: existing.endIndex, text: tag };
    let prefix = '';
    if (name === 'chat' && args.length === 2) prefix = ', null';
    const argumentSpan = call.childForFieldName('arguments')!;
    return { start: argumentSpan.endIndex - 1, end: argumentSpan.endIndex - 1, text: `${prefix}, ${tag}` };
  }));
  if (!edits) throw new Error('Java grammar unavailable; no source was changed.');
  return edits;
}

export function tagCallSites(root: string, assigned: AssignedSite[]): string[] {
  const writer = new ConfinedWriter({ root });
  const groups = new Map<string, AssignedSite[]>();
  for (const row of assigned) {
    if (!/^cs_[0-9a-f]{24}$/.test(row.id)) throw new Error('Invalid callsite tag.');
    if (row.site.op === 'read-output') continue;
    const rows = groups.get(row.site.relPath) ?? []; rows.push(row); groups.set(row.site.relPath, rows);
  }
  for (const [path, sites] of groups) {
    const text = readConfined(writer, path, 1024 * 1024);
    if (text === null) throw new Error('Source file became unreadable; no source was changed.');
    const language = sites[0]!.site.language;
    const edits = language === 'python' ? pyEdits(path, text, sites) : language === 'java' ? jEdits(path, text, sites)
      : ['typescript', 'javascript'].includes(language) ? tsEdits(path, text, sites) : (() => { throw new Error('Embed attribution requires a supported runtime transport.'); })();
    edits.sort((a, b) => b.start - a.start);
    let next = text; let boundary = text.length + 1;
    for (const edit of edits) {
      if (edit.end > boundary || edit.start < 0 || edit.end < edit.start) throw new Error('Ambiguous overlapping tag spans; no source was changed.');
      next = next.slice(0, edit.start) + edit.text + next.slice(edit.end); boundary = edit.start;
    }
    writer.create(writer.resolve(path), next, true);
  }
  return writer.commit().filter(row => row.action !== 'unchanged').map(row => row.path);
}
