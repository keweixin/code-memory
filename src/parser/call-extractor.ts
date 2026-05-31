/**
 * Code Memory Graph — Call Extractor
 *
 * Extracts function/method call relationships from a tree-sitter AST.
 * Produces CALLS edges that connect caller symbols to callee symbols.
 */

import { Query } from 'web-tree-sitter';
import type { Node, QueryMatch, Language as TSLang } from 'web-tree-sitter';
import type { CallReference } from '../shared/types.js';
import { ParserLanguage } from './types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('call-extractor');

// Language-specific call queries

const TS_CALL_QUERY = [
  '(call_expression) @call',
  '(new_expression) @call',
].join('\n');

const PY_CALL_QUERY = [
  '(call) @call',
  '(call function: (attribute attribute: (identifier) @callee) object: (_) @obj) @method_call',
].join('\n');

const GO_CALL_QUERY = [
  // Go call expressions
  '(call_expression function: (identifier) @callee) @call',
  '(call_expression function: (selector_expression field: (field_identifier) @callee) operand: (_) @obj) @method_call',
].join('\n');

function getCallQuery(lang: ParserLanguage): string | null {
  switch (lang) {
    case ParserLanguage.TypeScript:
    case ParserLanguage.TSX:
    case ParserLanguage.JavaScript:
    case ParserLanguage.JSX:
      return TS_CALL_QUERY;
    case ParserLanguage.Python:
      return PY_CALL_QUERY;
    case ParserLanguage.Go:
      return GO_CALL_QUERY;
    default:
      return null;
  }
}

/**
 * Finds the enclosing function/method name for a given node by walking up
 * the AST. Returns null if the call is at the top level.
 */
function findEnclosingSymbol(node: Node, rootNode: Node): { name: string; startLine: number } | null {
  try {
    let current: Node | null = node;
    while (current) {
      const type = current.type;
      if (type === 'function_declaration' ||
          type === 'method_definition' ||
          type === 'function_definition' ||
          type === 'method_declaration' ||
          type === 'arrow_function' ||
          type === 'function_expression' ||
          type === 'generator_function_declaration') {
        // Find the name child
        try {
          const nameNode = current.childForFieldName('name');
          if (nameNode) {
            const name = nameNode.text.trim();
            if (name) return { name, startLine: current.startPosition.row + 1 };
          }
        } catch {
          // No name field
        }

        const variableOwner = findVariableOwner(current);
        if (variableOwner) return variableOwner;

        return { name: 'anonymous_' + current.startIndex, startLine: current.startPosition.row + 1 };
      }
      current = current.parent;
      // Prevent walking beyond the tree root
      if (current && current.id === rootNode.id && current !== rootNode) {
        // We reached the root's parent — stop to avoid infinite loop
        return null;
      }
    }
  } catch {
    // Ignore traversal errors
  }
  return null;
}

function findVariableOwner(node: Node): { name: string; startLine: number } | null {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === 'variable_declarator') {
      const nameNode = current.childForFieldName('name');
      if (nameNode) {
        let declaration = current.parent;
        while (declaration && !declaration.type.endsWith('declaration')) {
          declaration = declaration.parent;
        }
        return {
          name: nameNode.text.trim(),
          startLine: (declaration || current).startPosition.row + 1,
        };
      }
    }
    if (current.type.endsWith('declaration') || current.type === 'statement_block') break;
    current = current.parent;
  }
  return null;
}

/**
 * Extract the callee name from a call_expression or new_expression node.
 */
function extractCalleeName(callNode: Node, lang: ParserLanguage): string | null {
  const firstChild = callNode.firstNamedChild;
  if (!firstChild) return null;

  // Direct function call: foo() -> identifier
  if (firstChild.type === 'identifier') {
    return firstChild.text.trim();
  }

  // Method call: obj.foo() -> member_expression -> property_identifier
  if (firstChild.type === 'member_expression') {
    // The last identifier child is the method name
    const children = firstChild.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i].type === 'property_identifier' || children[i].type === 'identifier') {
        return children[i].text.trim();
      }
    }
  }

  // Constructor call: new Foo() -> new_expression
  if (callNode.type === 'new_expression') {
    const idChild = firstChild.firstNamedChild;
    if (idChild && idChild.type === 'identifier') {
      return idChild.text.trim();
    }
    return firstChild.text.trim();
  }

  // Python: call -> first named child is the callee identifier
  if (firstChild.type === 'identifier' || firstChild.type === 'attribute') {
    return firstChild.text.trim();
  }

  // Go: call_expression -> first named child
  if (firstChild.type === 'identifier' || firstChild.type === 'selector_expression') {
    return firstChild.text.trim();
  }

  return null;
}

/**
 * Extract unresolved call references from a parsed AST.
 *
 * @param rootNode  The root syntax node
 * @param sourceCode  The original source code
 * @param fileId  The database ID of this file
 * @param lang  The parser language
 * @param tsLang  The tree-sitter Language object
 */
export function extractCallReferences(
  rootNode: Node,
  sourceCode: string,
  lang: ParserLanguage,
  tsLang: TSLang,
): CallReference[] {
  const qs = getCallQuery(lang);
  if (!qs) return [];

  let q: Query;
  try { q = new Query(tsLang, qs); }
  catch (e) { log.error('Call query compile failed', e); return []; }

  let ms: QueryMatch[];
  try { ms = q.matches(rootNode); }
  catch (e) { log.error('Call query match failed', e); return []; }

  const calls: CallReference[] = [];
  const seen = new Set<string>();

  for (const m of ms) {
    const callNode = m.captures[0]?.node;
    if (!callNode) continue;

    // Extract callee name from the call expression node
    // For call_expression: first child is the callee (identifier or member_expression)
    // For new_expression: look for constructor identifier
    const calleeName = extractCalleeName(callNode, lang);
    if (!calleeName || calleeName === 'undefined') continue;

    const caller = findEnclosingSymbol(callNode, rootNode);

    // Deduplicate
    const edgeKey = (caller?.name || '<file>') + '::' + callNode.startIndex + '::' + calleeName;
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);

    const callText = sourceCode.slice(callNode.startIndex, callNode.endIndex);

    calls.push({
      callerName: caller?.name || null,
      callerStartLine: caller?.startLine || null,
      calleeName,
      rangeStart: callNode.startPosition.row + 1,
      rangeEnd: callNode.endPosition.row + 1,
      evidence: callText.slice(0, 200),
    });
  }

  log.debug('Extracted ' + calls.length + ' call references');
  return calls;
}
