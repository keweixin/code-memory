/**
 * Code Memory Graph — Call Extractor
 *
 * Extracts function/method call relationships from a tree-sitter AST.
 * Produces CALLS edges that connect caller symbols to callee symbols.
 */

import { Query } from 'web-tree-sitter';
import type { Node, QueryMatch, Language as TSLang } from 'web-tree-sitter';
import type { EdgeRecord } from '../shared/types.js';
import { ParserLanguage } from './types.js';
import { generateId } from '../shared/utils.js';
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
function findEnclosingFunction(node: Node, rootNode: Node): string | null {
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
            if (name) return name;
          }
        } catch {
          // No name field
        }
        // For anonymous functions, use a synthetic name based on position
        return 'anonymous_' + current.startIndex;
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
 * Resolve a callee name within the same file, matching against known symbols.
 * Returns the symbol ID if found, null otherwise.
 */
function resolveCallee(
  calleeName: string,
  symbolNames: Map<string, string>,
): string | null {
  return symbolNames.get(calleeName) ?? null;
}

/**
 * Extract call edges from a parsed AST.
 *
 * @param rootNode  The root syntax node
 * @param sourceCode  The original source code
 * @param fileId  The database ID of this file
 * @param lang  The parser language
 * @param tsLang  The tree-sitter Language object
 * @param knownSymbols  Map of symbol name -> symbol ID in this file (for resolution)
 */
export function extractCalls(
  rootNode: Node,
  sourceCode: string,
  fileId: string,
  lang: ParserLanguage,
  tsLang: TSLang,
  knownSymbols: Map<string, string>,
): EdgeRecord[] {
  const qs = getCallQuery(lang);
  if (!qs) return [];

  let q: Query;
  try { q = new Query(tsLang, qs); }
  catch (e) { log.error('Call query compile failed', e); return []; }

  let ms: QueryMatch[];
  try { ms = q.matches(rootNode); }
  catch (e) { log.error('Call query match failed', e); return []; }

  const edges: EdgeRecord[] = [];
  const seen = new Set<string>();

  for (const m of ms) {
    const callNode = m.captures[0]?.node;
    if (!callNode) continue;

    // Extract callee name from the call expression node
    // For call_expression: first child is the callee (identifier or member_expression)
    // For new_expression: look for constructor identifier
    const calleeName = extractCalleeName(callNode, lang);
    if (!calleeName || calleeName === 'undefined') continue;

    // Find enclosing function (the caller)
    const callerName = findEnclosingFunction(callNode, rootNode);

    let callerId: string;
    if (callerName) {
      callerId = generateId(fileId, callerName);
    } else {
      callerId = fileId;
    }

    // Try to resolve the callee to a known symbol in this file
    const calleeId = resolveCallee(calleeName, knownSymbols);
    if (!calleeId) continue;

    // Deduplicate
    const edgeKey = callerId + '::' + calleeId + '::CALLS';
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);

    const callText = sourceCode.slice(callNode.startIndex, callNode.endIndex);

    edges.push({
      id: generateId('edge', callerId, calleeId, 'CALLS'),
      fromId: callerId,
      toId: calleeId,
      type: 'CALLS',
      confidence: 0.9,
      evidence: callText.slice(0, 200),
    });
  }

  log.debug('Extracted ' + edges.length + ' call edges from ' + fileId);
  return edges;
}
