import type { Detector } from '../types.js';
import { DETECTORS as TS } from './ts/index.js';
import { DETECTORS as HTML } from './html/index.js';
import { DETECTORS as PY } from './py/index.js';
import { DETECTORS as JAVA } from './java/index.js';

/** Every detector the scanner runs (docs/codemap/CONTRACT.md §7). Order is stable; ids are unique. */
export const DETECTORS: Detector[] = [...TS, ...HTML, ...PY, ...JAVA];
