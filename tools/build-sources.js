// Build script: generates parser and indexer source files
const fs = require("fs");
const path = require("path");
const base = path.resolve("C:/Users/ASUS/code-memory/src");
function writeFile(relPath, content) {
  const target = path.join(base, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log("OK: " + relPath);
}

// ===== import-export-extractor.ts =====
writeFile("parser/import-export-extractor.ts", [
"import { Query } from \"web-tree-sitter\";",
"import type { Node, QueryMatch, QueryCapture, Language as TSLang } from \"web-tree-sitter\";",
"import type { ImportInfo } from \"../shared/types.js\";",
"import { ParserLanguage } from \"./types.js\";",
"import { createLogger } from \"../shared/logger.js\";",
"const log = createLogger(\"import-export\");",
"const TS_IMP = [\"(import_statement source: (string) @source) @import\",\"(import_statement source: (string) @source import_clause: (named_imports (import_specifier name: (identifier) @name)*) @named) @import_named\"].join(\"\n\");",
"const PY_IMP = [\"(import_statement name: (dotted_name) @source) @import\",\"(import_from_statement module_name: (dotted_name) @source name: (dotted_name)? @name) @import_from\"].join(\"\n\");",
"const GO_IMP = \"(import_declaration (import_spec path: (interpreted_string_literal) @source)*) @import\";",
"const TS_EXP = [\"(export_statement source: (string) @reexport) @export\",\"(export_statement declaration: (function_declaration name: (identifier) @name) @decl) @export_fn\",\"(export_statement declaration: (class_declaration name: (type_identifier) @name) @decl) @export_cls\",\"(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)) @decl) @export_lex\",\"(export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name)) @decl) @export_var\",\"(export_default_declaration declaration: (_) @decl) @export_default\"].join(\"\n\");",
"function getImportQuery(lang) { switch(lang) { case ParserLanguage.TypeScript: case ParserLanguage.TSX: return TS_IMP; case ParserLanguage.JavaScript: case ParserLanguage.JSX: return TS_IMP; case ParserLanguage.Python: return PY_IMP; case ParserLanguage.Go: return GO_IMP; default: return null; } }",
"function getExportQuery(lang) { switch(lang) { case ParserLanguage.TypeScript: case ParserLanguage.TSX: case ParserLanguage.JavaScript: case ParserLanguage.JSX: return TS_EXP; default: return null; } }",
"function stripQuotes(s) { s = s.trim(); if ((s.startsWith(\"\\\"\")&&s.endsWith(\"\\\"\"))||(s.startsWith(\"x27\")&&s.endsWith(\"x27\"))||(s.startsWith(\"x60\")&&s.endsWith(\"x60\"))) s = s.slice(1,-1); return s; }",
"function findCap(caps, name) { for (const c of caps) if (c.name===name) return c; return null; }",
"export function extractImports(rootNode, sourceCode, lang, tsLang) {",
"  const qstr = getImportQuery(lang); if (!qstr) return [];",
"  let query; try { query = new (require(\"web-tree-sitter\").Query)(tsLang, qstr); } catch(e) { log.error(\"Import query fail\",e); return []; }",
"  let matches; try { matches = query.matches(rootNode); } catch(e) { log.error(\"Import match fail\",e); return []; }",
"  const result = []; const seen = new Set();",
"  for (const m of matches) {",
"    const sc = findCap(m.captures,\"source\"); if (!sc) continue;",
"    let src = stripQuotes(sc.node.text.trim()); if (!src) continue;",
"    if (seen.has(src)) continue; seen.add(src);",
"    const names = []; for (const c of m.captures) { if (c.name===\"name\") { const n = c.node.text.trim(); if (n) names.push(n); } }",
"    result.push({ source: src, names, isTypeOnly: false, isDefault: m.captures.some(c=>c.name===\"clause\") });",
"  }",
"  log.debug(\"Extracted \"+result.length+\" imports\");",
"  return result;",
"}",
"export function extractExports(rootNode, sourceCode, lang, tsLang) {",
"  if (lang===ParserLanguage.Python||lang===ParserLanguage.Go) {",
"    const names = []; try { for (const c of rootNode.namedChildren) { const nn = c.childForFieldName(\"name\"); if (nn) { const n = nn.text.trim(); if (n) { if (lang===ParserLanguage.Go) { if (n[0]>=\"A\"&&n[0]<=\"Z\") names.push(n); } else { names.push(n); } } } } } catch(e) {}",
"    return names;",
"  }",
"  const qstr = getExportQuery(lang); if (!qstr) return [];",
"  let query; try { query = new (require(\"web-tree-sitter\").Query)(tsLang, qstr); } catch(e) { log.error(\"Export query fail\",e); return []; }",
"  let matches; try { matches = query.matches(rootNode); } catch(e) { log.error(\"Export match fail\",e); return []; }",
"  const exports = new Set();",
"  for (const m of matches) {",
"    const nc = findCap(m.captures,\"name\"); if (nc) { const n=nc.node.text.trim(); if (n) exports.add(n); }",
"    const rc = findCap(m.captures,\"reexport\"); if (rc) { const r=stripQuotes(rc.node.text.trim()); if (r) exports.add(\"reexport:\"+r); }",
"  }",
"  return Array.from(exports);",
"}",
].join("
"));