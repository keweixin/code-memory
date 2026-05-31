import type { Node } from 'web-tree-sitter';
import type { SymbolRecord, TypeRelationRecord } from '../shared/types.js';
import { ParserLanguage } from './types.js';

export function extractTypeRelations(
  rootNode: Node,
  fileId: string,
  symbols: SymbolRecord[],
  lang: ParserLanguage,
): TypeRelationRecord[] {
  if (
    lang !== ParserLanguage.TypeScript &&
    lang !== ParserLanguage.TSX &&
    lang !== ParserLanguage.JavaScript &&
    lang !== ParserLanguage.JSX
  ) {
    return [];
  }

  const relations: TypeRelationRecord[] = [];
  walkNodes(rootNode, (node) => {
    if (node.type !== 'class_declaration' && node.type !== 'interface_declaration') return;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text.trim();
    const owner = symbols.find((symbol) => (
      symbol.name === name &&
      symbol.startLine === node.startPosition.row + 1 &&
      (symbol.kind === 'class' || symbol.kind === 'interface')
    ));
    const header = node.text.slice(0, Math.min(node.text.indexOf('{') >= 0 ? node.text.indexOf('{') : node.text.length, 400));

    for (const target of extractExtendsTargets(header, node.type === 'interface_declaration')) {
      relations.push({
        fileId,
        fromSymbolId: owner?.id ?? null,
        relationKind: 'EXTENDS',
        targetName: target,
        targetSymbolId: null,
        evidence: `${name} extends ${target}`,
      });
    }

    if (node.type === 'class_declaration') {
      for (const target of extractImplementsTargets(header)) {
        relations.push({
          fileId,
          fromSymbolId: owner?.id ?? null,
          relationKind: 'IMPLEMENTS',
          targetName: target,
          targetSymbolId: null,
          evidence: `${name} implements ${target}`,
        });
      }
    }
  });
  return relations;
}

function extractExtendsTargets(header: string, isInterface: boolean): string[] {
  const match = header.match(/\bextends\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/);
  if (!match) return [];
  const raw = isInterface ? match[1] : match[1].split(/\bimplements\b/)[0];
  return splitTypeList(raw);
}

function extractImplementsTargets(header: string): string[] {
  const match = header.match(/\bimplements\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/);
  return match ? splitTypeList(match[1]) : [];
}

function splitTypeList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim().match(/^[A-Za-z_$][\w$]*/)?.[0] || '')
    .filter(Boolean);
}

function walkNodes(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walkNodes(child, visit);
  }
}
