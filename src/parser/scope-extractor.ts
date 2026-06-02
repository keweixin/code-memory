import type { Node } from 'web-tree-sitter';
import type { ScopeBindingRecord, SymbolRecord } from '../shared/types.js';

export function extractScopeBindings(
  rootNode: Node,
  fileId: string,
  symbols: SymbolRecord[],
): ScopeBindingRecord[] {
  const bindings: ScopeBindingRecord[] = [];
  walkNodes(rootNode, (node) => {
    if (node.type !== 'variable_declarator') return;
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');
    if (!nameNode || !valueNode || nameNode.type !== 'identifier') return;

    const constructorName = extractConstructorName(valueNode);
    if (!constructorName) return;

    const owner = findEnclosingSymbol(symbols, node.startPosition.row + 1);
    bindings.push({
      fileId,
      symbolId: owner?.id ?? null,
      localName: nameNode.text.trim(),
      bindingKind: 'constructor',
      targetName: constructorName,
      targetSymbolId: null,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    });
  });
  return bindings;
}

function extractConstructorName(node: Node): string | null {
  if (node.type !== 'new_expression') return null;
  const first = node.firstNamedChild;
  if (!first) return null;
  if (first.type === 'identifier' || first.type === 'type_identifier') return first.text.trim();
  const nameNode = first.childForFieldName('name') || first.firstNamedChild;
  return nameNode?.text.trim() || first.text.trim() || null;
}

function findEnclosingSymbol(symbols: SymbolRecord[], line: number): SymbolRecord | null {
  const containing = symbols
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  return containing[0] ?? null;
}

function walkNodes(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walkNodes(child, visit);
  }
}
