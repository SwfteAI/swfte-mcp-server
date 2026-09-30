/** Widget embeds in TypeScript/JavaScript source: React components, `new SwfteChatWidget`, iframe markup. */
import { isGeneratedByOtherTool } from '../../walk.js';
import type { DetectContext, DetectResult, SourceFile } from '../../types.js';
import { isTestPath, mocksSwfte } from './common.js';
import { jsEmbedSites } from './embed.js';
import { hasGeneratedMarker } from './managed.js';
import { getParsed } from './parse.js';

/** Every widget embed of a file, resolved or not (the index splits them by category). */
export function widgetSites(file: SourceFile, _ctx: DetectContext): DetectResult {
  if (isTestPath(file.relPath) || mocksSwfte(file.text) || hasGeneratedMarker(file.text) || isGeneratedByOtherTool(file.text)) return { sites: [], implementations: [], envVarNames: [] };
  const sf = getParsed(file);
  const sites = jsEmbedSites(sf, { relPath: file.relPath, language: file.language === 'javascript' ? 'javascript' : 'typescript', detector: 'ts.widget', lineOffset: 0, global: false }, true);
  return { sites, implementations: [], envVarNames: [] };
}
