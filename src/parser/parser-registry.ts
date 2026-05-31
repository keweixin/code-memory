/**
 * Code Memory Graph — Parser Registry
 *
 * Manages web-tree-sitter initialization, WASM grammar loading,
 * and Parser instance pooling per language.
 *
 * Grammar .wasm files are resolved from:
 *   1. CODE_MEMORY_GRAMMARS
 *   2. CODE_MEMORY_PROJECT_ROOT/grammars
 *   3. process.cwd()/grammars
 *   4. The code-memory package grammars directory
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language as TreeSitterLanguage } from "web-tree-sitter";
import { ParserLanguage, LANGUAGE_CONFIGS, type LanguageConfig } from "./types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("parser-registry");

// Singleton state
let treeSitterInitialized = false;
const loadedLanguages = new Map<ParserLanguage, TreeSitterLanguage>();
const parserPool = new Map<ParserLanguage, Parser>();

/**
 * Initialize web-tree-sitter (must be called once before any parsing).
 * Idempotent — subsequent calls are no-ops.
 */
export async function initTreeSitter(): Promise<void> {
  if (treeSitterInitialized) return;
  await Parser.init();
  treeSitterInitialized = true;
  log.info("web-tree-sitter initialized");
}

/**
 * Load a grammar WASM and register it for the given language.
 * Searches multiple locations for the .wasm file.
 */
export async function loadLanguage(
  lang: ParserLanguage,
  wasmPath?: string,
): Promise<void> {
  if (!treeSitterInitialized) await initTreeSitter();

  const config = LANGUAGE_CONFIGS[lang];
  if (!config) throw new Error(`Unknown parser language: ${lang}`);

  const resolvedPath = wasmPath || resolveWasmPath(config);
  if (!resolvedPath) {
    const msg = [
      `Grammar WASM not found for ${config.name} (${config.wasmFile}).`,
      "Set CODE_MEMORY_GRAMMARS to a directory containing grammar .wasm files,",
      "or install the published package with bundled grammars.",
      "Run code-memory doctor to verify grammar resolution.",
    ].join("\n");
    log.error(msg);
    throw new Error(msg);
  }

  try {
    const wasmBytes = readFileSync(resolvedPath);
    const language = await TreeSitterLanguage.load(new Uint8Array(wasmBytes));
    loadedLanguages.set(lang, language);
    log.info(`Loaded grammar: ${config.name} from ${resolvedPath}`);
  } catch (err) {
    log.error(`Failed to load grammar for ${config.name}`, err);
    throw err;
  }
}

/**
 * Get a parser instance for a language (creates one if needed).
 */
export function getParser(lang: ParserLanguage): Parser | null {
  const language = loadedLanguages.get(lang);
  if (!language) return null;

  let parser = parserPool.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parserPool.set(lang, parser);
  }
  return parser;
}

/**
 * Directly parse source code for a language (loads grammar if needed).
 */
export function parse(lang: ParserLanguage, source: string) {
  const parser = getParser(lang);
  if (!parser) throw new Error(`Language not loaded: ${lang}. Call loadLanguage() first.`);
  return parser.parse(source);
}

/**
 * Return all loaded language enum values.
 */
export function getSupportedLanguages(): ParserLanguage[] {
  return Array.from(loadedLanguages.keys());
}

/**
 * Check if a language has been loaded.
 */
export function isLanguageLoaded(lang: ParserLanguage): boolean {
  return loadedLanguages.has(lang);
}

/**
 * Get the Grammar Language object for direct use with the Query API.
 */
export function getTreeSitterLanguage(lang: ParserLanguage): TreeSitterLanguage | null {
  return loadedLanguages.get(lang) || null;
}

// ── Private helpers ──────────────────────────────────────────

/**
 * Resolve the .wasm file path for a language by searching multiple locations.
 */
function resolveWasmPath(config: LanguageConfig): string | null {
  const searchPaths: string[] = [];

  // 1. GRAMMARS_DIR env var (user-specified)
  if (process.env.CODE_MEMORY_GRAMMARS) {
    searchPaths.push(join(process.env.CODE_MEMORY_GRAMMARS, config.wasmFile));
  }

  // 2. Project root grammars/ directory (worker-safe explicit root)
  if (process.env.CODE_MEMORY_PROJECT_ROOT) {
    searchPaths.push(join(process.env.CODE_MEMORY_PROJECT_ROOT, "grammars", config.wasmFile));
  }

  // 3. Project root grammars/ directory (relative to CWD)
  searchPaths.push(join(process.cwd(), "grammars", config.wasmFile));

  // 4. Package-relative grammars/ directory
  try {
    const pkgDir = dirname(fileURLToPath(import.meta.url));
    searchPaths.push(join(pkgDir, "..", "..", "grammars", config.wasmFile));
  } catch {
    // Available in Node.js ESM, skip if not
  }

  // 5. Absolute path from CWD
  searchPaths.push(pathResolve(config.wasmFile));

  for (const path of searchPaths) {
    if (existsSync(path)) {
      log.debug(`Resolved ${config.wasmFile} -> ${path}`);
      return path;
    }
  }

  return null;
}
