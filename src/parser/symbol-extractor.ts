/**
 * Code Memory Graph — Symbol Extractor
 *
 * Extracts symbols from a tree-sitter AST using the Query API.
 * Produces SymbolRecord entries for persistence.
 */

import { Query } from "web-tree-sitter";
import type { Node as TSNode, QueryMatch, QueryCapture, Language as TreeSitterLanguage } from "web-tree-sitter";
import type { SymbolRecord, SymbolKind, AccessLevel } from "../shared/types.js";
import { ParserLanguage } from "./types.js";
import { generateId, contentHash } from "../shared/utils.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("symbol-extractor");

// Tree-sitter query strings — one per language group

const TS_QUERY = [
  "(function_declaration",
  "  name: (_) @name",
  "  parameters: (_) @params",
  ") @func",
  "",
  "(generator_function_declaration",
  "  name: (_) @name",
  "  parameters: (_) @params",
  ") @genfunc",
  "",
  "(class_declaration",
  "  name: (_) @name",
  ") @class",
  "",
  "(interface_declaration",
  "  name: (_) @name",
  ") @iface",
  "",
  "(method_definition",
  "  name: (_) @name",
  "  parameters: (_) @params",
  ") @method",
  "",
  "(type_alias_declaration",
  "  name: (_) @name",
  ") @type_alias",
  "",
  "(enum_declaration",
  "  name: (_) @name",
  ") @enum",
  "",
  "(lexical_declaration",
  "  (variable_declarator",
  "    name: (_) @name)",
  ") @const",
  "",
  "(variable_declaration",
  "  (variable_declarator",
  "    name: (_) @name)",
  ") @var",
].join("\n");

const JS_QUERY = [
  "(function_declaration",
  "  name: (_) @name",
  "  parameters: (_) @params",
  ") @func",
  "",
  "(generator_function_declaration",
  "  name: (_) @name",
  "  parameters: (_) @params",
  ") @genfunc",
  "",
  "(class_declaration",
  "  name: (_) @name",
  ") @class",
  "",
  "(method_definition",
  "  name: (_) @name",
  "  parameters: (_) @params",
  ") @method",
  "",
  "(lexical_declaration",
  "  (variable_declarator",
  "    name: (_) @name)",
  ") @const",
  "",
  "(variable_declaration",
  "  (variable_declarator",
  "    name: (_) @name)",
  ") @var",
].join("\n");

const PY_QUERY = [
  "(function_definition",
  "  name: (_) @name",
  "  parameters: (_) @params",
  ") @func",
  "",
  "(class_definition",
  "  name: (_) @name",
  ") @class",
  "",
  "(decorated_definition",
  "  definition: (function_definition",
  "    name: (_) @name",
  "    parameters: (_) @params)",
  ") @decorated",
].join("\n");

const GO_QUERY = [
  "(function_declaration",
  "  name: (_) @name",
  "  parameters: (_) @params",
  "  result: (_)? @ret",
  ") @func",
  "",
  "(method_declaration",
  "  name: (_) @name",
  "  parameters: (_) @params",
  "  result: (_)? @ret",
  ") @method",
  "",
  "(type_declaration",
  "  (type_spec",
  "    name: (_) @name)",
  ") @gostruct",
  "",
  "(type_declaration",
  "  (type_spec",
  "    name: (_) @name",
  "    type: (_) @body)",
  ") @goiface",
  "",
  "(var_spec",
  "  name: (_) @name",
  ") @govar",
  "",
  "(const_spec",
  "  name: (_) @name",
  ") @goconst",
].join("\n");

const CAPTURE_TO_KIND: Record<string, SymbolKind> = {
  func: "function",
  genfunc: "function",
  class: "class",
  iface: "interface",
  method: "method",
  type_alias: "type",
  enum: "enum",
  const: "constant",
  var: "variable",
  decorated: "function",
  gostruct: "class",
  goiface: "interface",
  govar: "variable",
  goconst: "constant",
};

export function extractSymbols(
  rootNode: TSNode,
  sourceCode: string,
  fileId: string,
  lang: ParserLanguage,
  tsLang: TreeSitterLanguage,
): SymbolRecord[] {
  const queryStr = getQueryForLanguage(lang);
  if (!queryStr) { log.warn("No query for " + lang); return []; }
  let query: Query;
  try { query = new Query(tsLang, queryStr); }
  catch (err) { log.error("Query compile failed", err); return []; }
  let matches: QueryMatch[];
  try { matches = query.matches(rootNode); }
  catch (err) { log.error("Query exec failed", err); return []; }
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const sym = buildSymbol(match, sourceCode, fileId);
    if (sym && !seen.has(sym.id)) {
      seen.add(sym.id);
      symbols.push(sym);
    }
  }
  for (const sym of extractAnonymousDefaultExportSymbols(rootNode, sourceCode, fileId, lang)) {
    if (!seen.has(sym.id)) {
      seen.add(sym.id);
      symbols.push(sym);
    }
  }
  log.debug("Extracted " + symbols.length + " symbols from " + fileId);
  return symbols;
}

function getQueryForLanguage(lang: ParserLanguage): string | null {
  switch (lang) {
    case ParserLanguage.TypeScript: case ParserLanguage.TSX: return TS_QUERY;
    case ParserLanguage.JavaScript: case ParserLanguage.JSX: return JS_QUERY;
    case ParserLanguage.Python: return PY_QUERY;
    case ParserLanguage.Go: return GO_QUERY;
    default: return null;
  }
}

function buildSymbol(match: QueryMatch, sourceCode: string, fileId: string): SymbolRecord | null {
  const kindCapture = findKindCapture(match.captures);
  if (!kindCapture) return null;
  const kind = CAPTURE_TO_KIND[kindCapture.name];
  if (!kind) return null;
  const declNode = kindCapture.node;
  const nameCapture = findNameCapture(match.captures);
  if (!nameCapture) return null;
  const name = nameCapture.node.text.trim();
  if (!name) return null;
  const accessLevel = determineAccessLevel(match.captures);
  return createSymbolRecord(declNode, sourceCode, fileId, name, kind, accessLevel);
}

function createSymbolRecord(
  declNode: TSNode,
  sourceCode: string,
  fileId: string,
  name: string,
  kind: SymbolKind,
  accessLevel: AccessLevel | null,
): SymbolRecord {
  const symbolSource = sourceCode.slice(declNode.startIndex, declNode.endIndex);
  const signature = buildSignature(symbolSource);
  const hash = contentHash(symbolSource);
  const startLine = declNode.startPosition.row + 1;
  const endLine = declNode.endPosition.row + 1;
  const startColumn = declNode.startPosition.column;
  const endColumn = declNode.endPosition.column;
  const symbolId = generateId(fileId, kind, name, String(startLine));
  return {
    id: symbolId,
    fileId,
    name,
    kind,
    startByte: declNode.startIndex,
    endByte: declNode.endIndex,
    startLine,
    endLine,
    startColumn,
    endColumn,
    rangeStart: startLine,
    rangeEnd: endLine,
    signature,
    summary: null,
    hash,
    accessLevel,
  };
}

function extractAnonymousDefaultExportSymbols(
  rootNode: TSNode,
  sourceCode: string,
  fileId: string,
  lang: ParserLanguage,
): SymbolRecord[] {
  if (
    lang !== ParserLanguage.TypeScript &&
    lang !== ParserLanguage.TSX &&
    lang !== ParserLanguage.JavaScript &&
    lang !== ParserLanguage.JSX
  ) {
    return [];
  }

  const symbols: SymbolRecord[] = [];
  walkNodes(rootNode, (node) => {
    if (node.type !== "export_statement") return;
    const text = node.text.trimStart();
    if (!text.startsWith("export default")) return;

    const isAnonymousFunction = /^export\s+default\s+(?:async\s+)?function\s*(?:<|\()/.test(text);
    const isAnonymousClass = /^export\s+default\s+class\s*(?:\{|extends\b)/.test(text);
    if (!isAnonymousFunction && !isAnonymousClass) return;

    symbols.push(createSymbolRecord(
      node,
      sourceCode,
      fileId,
      "default",
      isAnonymousClass ? "class" : "function",
      null,
    ));
  });

  return symbols;
}

function walkNodes(node: TSNode, visit: (node: TSNode) => void): void {
  visit(node);
  for (const child of node.children) {
    walkNodes(child, visit);
  }
}

function buildSignature(symbolSource: string): string {
  const trimmed = symbolSource.trim();
  const bodyStart = trimmed.indexOf("{");
  if (bodyStart >= 0) {
    return trimmed.slice(0, bodyStart).trim();
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
  return firstLine || trimmed;
}

function findKindCapture(captures: QueryCapture[]): QueryCapture | null {
  for (const cap of captures) { if (cap.name in CAPTURE_TO_KIND) return cap; }
  return null;
}

function findNameCapture(captures: QueryCapture[]): QueryCapture | null {
  for (const cap of captures) { if (cap.name === "name" || cap.name.endsWith("_name")) return cap; }
  return null;
}

function determineAccessLevel(captures: QueryCapture[]): AccessLevel | null {
  for (const cap of captures) {
    if (cap.name === "access") {
      const t = cap.node.text.trim();
      if (t === "public") return "public";
      if (t === "private") return "private";
      if (t === "protected") return "protected";
    }
  }
  return null;
}
