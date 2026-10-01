import type { Detector } from '../../types.js';
import { htmlWidgetDetector } from './widget.js';

/** HTML-template detectors, used for every language's templates (docs/codemap/CONTRACT.md §7). */
export const DETECTORS: Detector[] = [htmlWidgetDetector];
