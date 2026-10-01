/** One parse per file shared by the detectors that run over it (they run back to back). */
import type ts from 'typescript';
import type { SourceFile } from '../../types.js';
import { parseSource } from './common.js';

let last: { relPath: string; text: string; sf: ts.SourceFile } | null = null;

export function getParsed(file: SourceFile): ts.SourceFile {
  if (last && last.relPath === file.relPath && last.text === file.text) return last.sf;
  const sf = parseSource(file.relPath, file.text);
  last = { relPath: file.relPath, text: file.text, sf };
  return sf;
}
