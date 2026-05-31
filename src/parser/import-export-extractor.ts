/**
 * Code Memory Graph — Import / Export Extractor
 *
 * Extracts import and export relationships from a tree-sitter AST.
 * These form the IMPORTS and EXPORTS_TO edges in the code graph.
 */

import { Query } from 'web-tree-sitter';
import type { Node, QueryMatch, Language as TSLang } from 'web-tree-sitter';
import type { ImportInfo } from '../shared/types.js';
import { ParserLanguage } from './types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('import-export');

// Language-specific query strings

const TS_IMPORT_QUERY = [
  '(import_statement) @import',
].join('\n');

const PY_IMPORT_QUERY = [
  '(import_statement) @import',
  '(import_from_statement) @import',
].join('\n');

const GO_IMPORT_QUERY = '(import_declaration) @import';

const TS_EXPORT_QUERY = [
  '(export_statement) @export',
].join('\n');

function getImportQuery(lang: ParserLanguage): string | null {
  switch (lang) {
    case ParserLanguage.TypeScript:
    case ParserLanguage.TSX:
    case ParserLanguage.JavaScript:
    case ParserLanguage.JSX:
      return TS_IMPORT_QUERY;
    case ParserLanguage.Python:
      return PY_IMPORT_QUERY;
    case ParserLanguage.Go:
      return GO_IMPORT_QUERY;
    default:
      return null;
  }
}

function getExportQuery(lang: ParserLanguage): string | null {
  switch (lang) {
    case ParserLanguage.TypeScript:
    case ParserLanguage.TSX:
    case ParserLanguage.JavaScript:
    case ParserLanguage.JSX:
      return TS_EXPORT_QUERY;
    default:
      return null;
  }
}

function stripQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

export function extractImports(
  rootNode: Node,
  _sourceCode: string,
  lang: ParserLanguage,
  tsLang: TSLang,
): ImportInfo[] {
  const qs = getImportQuery(lang);
  if (!qs) return [];
  let q: Query;
  try { q = new Query(tsLang, qs); }
  catch (e) { log.error('Import query compile failed', e); return []; }
  let ms: QueryMatch[];
  try { ms = q.matches(rootNode); }
  catch (e) { log.error('Import query match failed', e); return []; }

  const result: ImportInfo[] = [];
  const seen = new Set<string>();

  for (const m of ms) {
    const node = m.captures[0]?.node;
    if (!node) continue;

    // Extract source path from string children
    let src = '';
    const strings = extractStringChildren(node);
    if (strings.length > 0) src = stripQuotes(strings[strings.length - 1]);
    if (!src || seen.has(src)) continue;
    seen.add(src);

    // Extract imported names from identifier children
    const names = extractIdentifierNames(node)
      .filter(n => n !== 'import' && n !== 'from' && n !== 'type');

    result.push({
      source: src,
      names,
      isTypeOnly: node.text.startsWith('import type'),
      isDefault: names.length > 0 && !node.text.includes('{'),
    });
  }
  log.debug('Extracted ' + result.length + ' imports');
  return result;
}

export function extractExports(
  rootNode: Node,
  _sourceCode: string,
  lang: ParserLanguage,
  tsLang: TSLang,
): string[] {
  if (lang === ParserLanguage.Python || lang === ParserLanguage.Go) {
    const names: string[] = [];
    for (const child of rootNode.namedChildren) {
      if (lang === ParserLanguage.Go) {
        const first = child.text.charAt(0);
        if (first >= 'A' && first <= 'Z') names.push(child.text.trim().split(/\s/)[0]);
      }
    }
    return names;
  }

  const qs = getExportQuery(lang);
  if (!qs) return [];
  let q: Query;
  try { q = new Query(tsLang, qs); }
  catch (e) { log.error('Export query compile failed', e); return []; }
  let ms: QueryMatch[];
  try { ms = q.matches(rootNode); }
  catch (e) { log.error('Export query match failed', e); return []; }

  const ex = new Set<string>();
  for (const m of ms) {
    const node = m.captures[0]?.node;
    if (!node) continue;

    // Check if it's a re-export (export { x } from '...' or export * from '...')
    const strings = extractStringChildren(node);
    if (strings.length > 0) {
      ex.add('reexport:' + stripQuotes(strings[0]));
    }

    // Extract declared names (function/class/variable names)
    const names = extractIdentifierNames(node)
      .filter(n => !['export', 'default', 'function', 'class', 'const', 'let', 'var', 'type', 'interface', 'abstract'].includes(n) && !n.startsWith('reexport'));
    for (const n of names) ex.add(n);
  }
  return Array.from(ex);
}

// ── Node walk helpers ───────────────────────────────────────

function extractStringChildren(node: Node): string[] {
  const results: string[] = [];
  walkChildren(node, (n) => {
    if (n.type === 'string' || n.type === 'string_fragment') {
      results.push(n.text);
    }
  });
  return results;
}

function extractIdentifierNames(node: Node): string[] {
  const results: string[] = [];
  walkChildren(node, (n) => {
    if (n.type === 'identifier' || n.type === 'property_identifier' || n.type === 'type_identifier') {
      results.push(n.text);
    }
  });
  return results;
}

function walkChildren(node: Node, fn: (n: Node) => void): void {
  for (const child of node.children) {
    fn(child);
    if (child.children.length > 0) walkChildren(child, fn);
  }
}
