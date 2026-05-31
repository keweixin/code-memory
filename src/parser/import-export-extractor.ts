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

    const bindings = extractImportBindings(node.text);

    result.push({
      source: src,
      names: bindings.names,
      aliases: bindings.aliases,
      isTypeOnly: node.text.startsWith('import type'),
      isDefault: bindings.isDefault,
      defaultName: bindings.defaultName,
      isNamespace: bindings.isNamespace,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
    });
  }
  log.debug('Extracted ' + result.length + ' imports');
  return result;
}

function extractImportBindings(importText: string): {
  names: string[];
  aliases: Record<string, string>;
  isDefault: boolean;
  defaultName?: string;
  isNamespace: boolean;
} {
  const aliases: Record<string, string> = {};
  const names: string[] = [];
  const add = (importedName: string, localName: string = importedName) => {
    if (!importedName || importedName === 'type') return;
    if (!names.includes(importedName)) names.push(importedName);
    aliases[localName] = importedName;
  };

  const namedBlock = importText.match(/\{([\s\S]*?)\}/);
  if (namedBlock) {
    for (const rawPart of namedBlock[1].split(',')) {
      const cleaned = rawPart.trim().replace(/^type\s+/, '');
      if (!cleaned) continue;
      const aliasMatch = cleaned.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) {
        add(aliasMatch[1], aliasMatch[2]);
        continue;
      }
      const nameMatch = cleaned.match(/^([A-Za-z_$][\w$]*)$/);
      if (nameMatch) add(nameMatch[1]);
    }
  }

  const namespaceMatch = importText.match(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+/);
  const isNamespace = Boolean(namespaceMatch);
  if (namespaceMatch) {
    add(namespaceMatch[1]);
  }

  const defaultMatch = importText.match(/^import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from\s+)/);
  const hasDefault = Boolean(defaultMatch) && !importText.startsWith('import type');
  const defaultName = hasDefault ? defaultMatch?.[1] : undefined;

  if (names.length === 0) {
    for (const n of extractImportIdentifiersFallback(importText)) add(n);
  }

  return { names, aliases, isDefault: hasDefault, defaultName, isNamespace };
}

function extractImportIdentifiersFallback(importText: string): string[] {
  return importText
    .replace(/(['"]).*?\1/g, '')
    .split(/[^A-Za-z_$\w]+/)
    .filter((n) => n && !['import', 'from', 'type', 'as'].includes(n));
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
      const source = stripQuotes(strings[0]);
      ex.add('reexport:' + source);
      for (const alias of extractExportAliases(node.text)) {
        ex.add('reexportAlias:' + JSON.stringify({ source, ...alias }));
      }
    }

    // Extract declared names (function/class/variable names)
    const names = extractIdentifierNames(node)
      .filter(n => !['export', 'default', 'function', 'class', 'const', 'let', 'var', 'type', 'interface', 'abstract'].includes(n) && !n.startsWith('reexport'));
    for (const n of names) ex.add(n);
  }
  return Array.from(ex);
}

function extractExportAliases(exportText: string): Array<{ importedName: string; exportedName: string }> {
  const namedBlock = exportText.match(/\{([\s\S]*?)\}/);
  if (!namedBlock) return [];

  const aliases: Array<{ importedName: string; exportedName: string }> = [];
  for (const rawPart of namedBlock[1].split(',')) {
    const cleaned = rawPart.trim().replace(/^type\s+/, '');
    if (!cleaned) continue;

    const aliasMatch = cleaned.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (aliasMatch) {
      aliases.push({ importedName: aliasMatch[1], exportedName: aliasMatch[2] });
      continue;
    }

    const nameMatch = cleaned.match(/^([A-Za-z_$][\w$]*)$/);
    if (nameMatch) {
      aliases.push({ importedName: nameMatch[1], exportedName: nameMatch[1] });
    }
  }

  return aliases;
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
