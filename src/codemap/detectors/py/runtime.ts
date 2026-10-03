import { Parser } from 'web-tree-sitter';

let ready: Promise<void> | null = null;

/**
 * Initialise the web-tree-sitter runtime once per process. The Python and Java parsers both start at
 * import time; a second concurrent `Parser.init()` would leave one of them without a grammar.
 */
export function initRuntime(): Promise<void> {
  ready ??= Parser.init().catch((e: unknown) => {
    ready = null;
    throw e;
  });
  return ready;
}
