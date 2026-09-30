/**
 * Widget embeds in HTML templates (`.html`, `.htm`, `.jinja`, `.j2`): `<iframe src=".../chat/<id>">`,
 * inline `<script>` that builds a `SwfteChatWidget`, and an inline config naming the public agent chat
 * endpoint. Used for every language's templates. HTML comments are never read; the loader
 * `<script src>` is never the site; a template placeholder in the id position is reported unresolved.
 */
import type { DetectContext, DetectedSite, DetectResult, Detector, SourceFile } from '../../types.js';
import { endpointConfigSites, iframeEmbeds, inlineScripts, jsEmbedSites } from '../ts/embed.js';
import { isTestPath, parseSource } from '../ts/common.js';
import ts from 'typescript';

const DETECTOR_ID = 'html.widget';

export const htmlWidgetDetector: Detector = {
  id: DETECTOR_ID,
  languages: ['html'],
  detect(file: SourceFile, _ctx: DetectContext): DetectResult {
    const empty: DetectResult = { sites: [], implementations: [], envVarNames: [] };
    if (isTestPath(file.relPath)) return empty;
    const sites: DetectedSite[] = [];
    const base = { relPath: file.relPath, language: 'html' as const, detector: DETECTOR_ID };
    for (const e of iframeEmbeds(file.text)) {
      const unresolved = e.id === null;
      sites.push({
        ...base,
        line: e.lineDelta + 1,
        symbol: '<module>',
        category: unresolved ? 'dynamic' : 'widget',
        sdk: 'widget-embed',
        op: 'embed',
        managed: 'typed-client',
        artifact: { kind: 'agent', id: e.id, unresolved, pinnedVersion: null, alias: null },
        contractHash: null,
        inputKeys: [],
        outputKeys: [],
      });
    }
    for (const s of inlineScripts(file.text)) {
      const sf = parseSource('inline.js', s.body, ts.ScriptKind.JS);
      const ctx = { ...base, lineOffset: s.lineDelta, global: true };
      sites.push(...jsEmbedSites(sf, ctx, false), ...endpointConfigSites(sf, ctx));
    }
    sites.sort((a, b) => a.line - b.line);
    return { sites, implementations: [], envVarNames: [] };
  },
};
