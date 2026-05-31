/**
 * Code Memory Graph — Tree-sitter Parser
 *
 * Unified parser that orchestrates the complete parsing pipeline:
 *   load language -> parse AST -> extract symbols/imports/exports/calls
 *
 * Returns a ParseResult containing all extracted records.
 */

import { Parser } from 'web-tree-sitter';
import type { Node, Language as TSLang } from 'web-tree-sitter';
import type { ParseResult, ParseError, SymbolRecord, ImportInfo, ChunkRecord } from '../shared/types.js';
import { ParserLanguage, EXTENSION_TO_PARSER_LANGUAGE } from './types.js';
import { getParser, getTreeSitterLanguage, loadLanguage } from './parser-registry.js';
import { extractSymbols } from './symbol-extractor.js';
import { extractImports, extractExports } from './import-export-extractor.js';
import { extractCallReferences } from './call-extractor.js';
import { generateId, contentHash } from '../shared/utils.js';
import { estimateTokens } from '../shared/token-counter.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('tree-sitter-parser');

export async function parseFile(
  filePath: string,
  sourceCode: string,
  parserLang: ParserLanguage,
  fileId: string,
): Promise<ParseResult> {
  const errors: ParseError[] = [];

  if (!getParser(parserLang)) {
    try { await loadLanguage(parserLang); }
    catch (err) {
      const msg = 'Failed to load language grammar for ' + parserLang;
      log.error(msg, err);
      return createEmptyResult(fileId, filePath, msg);
    }
  }

  const parser = getParser(parserLang);
  const tsLang = getTreeSitterLanguage(parserLang);
  if (!parser || !tsLang) {
    return createEmptyResult(fileId, filePath, 'Parser not available for ' + parserLang);
  }

  let tree;
  try { tree = parser.parse(sourceCode); }
  catch (err) {
    const msg = 'Parse failed: ' + (err instanceof Error ? err.message : String(err));
    log.error(msg, err);
    return createEmptyResult(fileId, filePath, msg);
  }

  if (!tree) return createEmptyResult(fileId, filePath, '', true);

  const rootNode = tree.rootNode;
  collectParseErrors(rootNode, filePath, errors);

  let symbols: SymbolRecord[] = [];
  try { symbols = extractSymbols(rootNode, sourceCode, fileId, parserLang, tsLang); }
  catch (err) { log.error('Symbol extraction failed', err); }

  let imports: ImportInfo[] = [];
  try { imports = extractImports(rootNode, sourceCode, parserLang, tsLang); }
  catch (err) { log.error('Import extraction failed', err); }

  let exports: string[] = [];
  try { exports = extractExports(rootNode, sourceCode, parserLang, tsLang); }
  catch (err) { log.error('Export extraction failed', err); }

  let calls: ParseResult['calls'] = [];
  try { calls = extractCallReferences(rootNode, sourceCode, parserLang, tsLang); }
  catch (err) { log.error('Call extraction failed', err); }

  const chunks = createSymbolChunks(fileId, symbols);

  try { tree.delete(); } catch {}

  const language = parserLangToLanguage(parserLang);

  log.debug(
    'Parsed ' + filePath + ': ' + symbols.length + ' symbols, ' +
    imports.length + ' imports, ' + exports.length + ' exports, ' +
    calls.length + ' call refs'
  );

  return {
    fileId, filePath, language, symbols, imports, exports, edges: [],
    calls, chunks, errors,
  };
}

export function resolveParserLanguage(filePath: string): ParserLanguage | null {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0) return null;
  let ext = filePath.slice(lastDot).toLowerCase();
  if (ext === '.ts' && filePath.endsWith('.d.ts')) ext = '.ts';
  return EXTENSION_TO_PARSER_LANGUAGE[ext] ?? null;
}

function createEmptyResult(
  fileId: string, filePath: string, errorMsg: string, noError?: boolean,
): ParseResult {
  const errors: ParseError[] = [];
  if (errorMsg && !noError) {
    errors.push({ filePath, line: null, message: errorMsg, severity: 'error' });
  }
  return {
    fileId, filePath, language: 'unknown',
    symbols: [], imports: [], exports: [], edges: [], calls: [], chunks: [], errors,
  };
}

function createSymbolChunks(fileId: string, symbols: SymbolRecord[]): ChunkRecord[] {
  return symbols
    .filter((symbol) => symbol.signature && symbol.signature.trim().length > 0)
    .map((symbol) => {
      const content = symbol.signature || '';
      const hash = contentHash(content);
      return {
        id: generateId('chunk', symbol.id, hash),
        fileId,
        symbolId: symbol.id,
        startByte: symbol.startByte,
        endByte: symbol.endByte,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        startColumn: symbol.startColumn,
        endColumn: symbol.endColumn,
        contentHash: hash,
        content,
        tokenCount: estimateTokens(content),
        summary: null,
        embeddingId: null,
      };
    });
}

function parserLangToLanguage(lang: ParserLanguage): ParseResult['language'] {
  switch (lang) {
    case ParserLanguage.TypeScript: case ParserLanguage.TSX: return 'typescript';
    case ParserLanguage.JavaScript: case ParserLanguage.JSX: return 'javascript';
    case ParserLanguage.Python: return 'python';
    case ParserLanguage.Go: return 'go';
    default: return 'unknown';
  }
}

function collectParseErrors(node: Node, filePath: string, errors: ParseError[]): void {
  try {
    if (node.isError || node.isMissing) {
      const line = node.startPosition.row + 1;
      const msg = node.isError
        ? 'Syntax error: ' + (node.text.slice(0, 80) || '(empty)')
        : 'Missing node: ' + node.type;
      errors.push({ filePath, line, message: msg, severity: 'error' });
    }
    for (const child of node.namedChildren) {
      collectParseErrors(child, filePath, errors);
    }
  } catch {}
}
