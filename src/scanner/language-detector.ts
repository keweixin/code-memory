/**
 * Code Memory Graph — Language Detector
 *
 * Maps file extensions to programming languages using the
 * EXTENSION_TO_LANGUAGE constant from shared/constants.
 */

import { EXTENSION_TO_LANGUAGE } from '../shared/constants.js';
import type { Language } from '../shared/types.js';
import { getExtension } from '../shared/utils.js';

/**
 * Ambiguous extensions that need explicit overrides.
 * The constants mapping includes them under their primary language
 * already, but we add explicit handling here for clarity and
 * future-proofing.
 */
const EXTENSION_OVERRIDES: Record<string, Language> = {
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.mts': 'typescript',
  '.cts': 'typescript',
};

/**
 * Detect the programming language of a file based on its extension.
 *
 * Returns 'unknown' for unrecognized extensions.
 */
export function detectLanguage(filePath: string): Language {
  const ext = getExtension(filePath);

  // Check explicit overrides first (handles ambiguous extensions)
  if (ext in EXTENSION_OVERRIDES) {
    return EXTENSION_OVERRIDES[ext];
  }

  // Fall back to the constants mapping
  const language = EXTENSION_TO_LANGUAGE[ext];
  if (language) {
    return language as Language;
  }

  return 'unknown';
}