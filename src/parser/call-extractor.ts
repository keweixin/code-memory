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

function findEnclosingClass(node: Node): string | null {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class') {
      const nameNode = current.childForFieldName('name');
      return nameNode?.text.trim() || null;
    }
    current = current.parent;
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
interface ExtractedCallParts {
  calleeName: string;
  receiverName: string | null;
  receiverKind: CallReference['receiverKind'];
  memberName: string | null;
  isConstructorCall: boolean;
}

function extractCallParts(callNode: Node, lang: ParserLanguage): ExtractedCallParts | null {
  const firstChild = callNode.firstNamedChild;
  if (!firstChild) return null;

  // Direct function call: foo() -> identifier
  if (firstChild.type === 'identifier') {
    return {
      calleeName: firstChild.text.trim(),
      receiverName: null,
      receiverKind: null,
      memberName: null,
      isConstructorCall: false,
    };
  }

  // Method call: obj.foo() -> member_expression -> property_identifier
  if (firstChild.type === 'member_expression') {
    const objectNode = firstChild.childForFieldName('object') || firstChild.namedChildren[0] || null;
    const propertyNode = firstChild.childForFieldName('property') || firstChild.namedChildren[firstChild.namedChildren.length - 1] || null;
    const memberName = propertyNode?.text.trim() || null;
    if (!memberName) return null;
    const receiverName = simplifyReceiverName(objectNode);
    return {
      calleeName: memberName,
      receiverName,
      receiverKind: receiverName === 'this'
        ? 'this'
        : receiverName && /^[A-Za-z_$][\w$]*$/.test(receiverName)
          ? 'identifier'
          : 'unknown',
      memberName,
      isConstructorCall: false,
    };
  }

  if (firstChild.type === 'subscript_expression') {
    return null;
  }

  if (firstChild.type === 'call_expression') {
    const nested = extractCallParts(firstChild, lang);
    if (nested) return nested;
  }

  if (firstChild.type === 'identifier' || firstChild.type === 'attribute') {
    return {
      calleeName: firstChild.text.trim(),
      receiverName: null,
      receiverKind: null,
      memberName: null,
      isConstructorCall: false,
    };
  }

  if (firstChild.type === 'selector_expression') {
    const children = firstChild.namedChildren;
    const memberName = children[children.length - 1]?.text.trim();
    if (!memberName) return null;
    return {
      calleeName: memberName,
      receiverName: simplifyReceiverName(children[0] || null),
      receiverKind: 'identifier',
      memberName,
      isConstructorCall: false,
    };
  }

  return null;
}

/**
 * Extract constructor callee from a new_expression node.
 */
function extractConstructorParts(callNode: Node): ExtractedCallParts | null {
  const firstChild = callNode.firstNamedChild;
  if (!firstChild) return null;
  let calleeName = '';
  if (firstChild.type === 'identifier' || firstChild.type === 'type_identifier') {
    calleeName = firstChild.text.trim();
  } else if (firstChild.type === 'member_expression') {
    const propertyNode = firstChild.childForFieldName('property') || firstChild.namedChildren[firstChild.namedChildren.length - 1];
    calleeName = propertyNode?.text.trim() || '';
  } else {
    const idChild = firstChild.firstNamedChild;
    calleeName = idChild?.text.trim() || firstChild.text.trim();
  }
  if (!calleeName) return null;
  return {
    calleeName,
    receiverName: null,
    receiverKind: 'constructor',
    memberName: calleeName,
    isConstructorCall: true,
  };
}

function simplifyReceiverName(node: Node | null): string | null {
  if (!node) return null;
  const text = node.text.trim();
  if (!text) return null;
  if (text === 'this' || /^[A-Za-z_$][\w$]*$/.test(text)) return text;
  const finalIdentifier = text.match(/([A-Za-z_$][\w$]*)$/)?.[1];
  return finalIdentifier || text.slice(0, 80);
}

function extractCalleeName(callNode: Node, lang: ParserLanguage): string | null {
  if (callNode.type === 'new_expression') {
    return extractConstructorParts(callNode)?.calleeName ?? null;
  }
  return extractCallParts(callNode, lang)?.calleeName ?? null;
}

function getCallParts(callNode: Node, lang: ParserLanguage): ExtractedCallParts | null {
  if (callNode.type === 'new_expression') {
    return extractConstructorParts(callNode);
  }
  return extractCallParts(callNode, lang);
}

/**
 * Kept for older parser paths that only need the string callee.
 */
function _extractLegacyCalleeName(callNode: Node, _lang: ParserLanguage): string | null {
  const firstChild = callNode.firstNamedChild;
  if (!firstChild) return null;

  if (firstChild.type === 'identifier') {
    return firstChild.text.trim();
  }

  if (firstChild.type === 'member_expression') {
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
    const parts = getCallParts(callNode, lang);
    const calleeName = parts?.calleeName || extractCalleeName(callNode, lang);
    if (!calleeName || calleeName === 'undefined' || !parts) continue;

    const caller = findEnclosingSymbol(callNode, rootNode);
    const callerClassName = findEnclosingClass(callNode);

    // Deduplicate
    const edgeKey = (caller?.name || '<file>') + '::' + callNode.startIndex + '::' + calleeName;
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);

    const callText = sourceCode.slice(callNode.startIndex, callNode.endIndex);

    calls.push({
      callerName: caller?.name || null,
      callerStartLine: caller?.startLine || null,
      calleeName,
      callerClassName,
      receiverName: parts.receiverName,
      receiverKind: parts.receiverKind,
      memberName: parts.memberName,
      isConstructorCall: parts.isConstructorCall,
      rangeStart: callNode.startPosition.row + 1,
      rangeEnd: callNode.endPosition.row + 1,
      startColumn: callNode.startPosition.column,
      evidence: callText.slice(0, 200),
    });
  }

  log.debug('Extracted ' + calls.length + ' call references');
  return calls;
}
