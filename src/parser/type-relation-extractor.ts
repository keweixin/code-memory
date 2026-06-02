import type { Node } from 'web-tree-sitter';
import type { SymbolRecord, TypeRelationRecord } from '../shared/types.js';
import { ParserLanguage } from './types.js';

export function extractTypeRelations(
  rootNode: Node,
  fileId: string,
  symbols: SymbolRecord[],
  lang: ParserLanguage,
): TypeRelationRecord[] {
  switch (lang) {
    case ParserLanguage.TypeScript:
    case ParserLanguage.TSX:
    case ParserLanguage.JavaScript:
    case ParserLanguage.JSX:
      return extractTsJsTypeRelations(rootNode, fileId, symbols);
    case ParserLanguage.Python:
      return extractPythonTypeRelations(rootNode, fileId, symbols);
    case ParserLanguage.Go:
      return extractGoTypeRelations(rootNode, fileId, symbols);
    default:
      return [];
  }
}

function extractTsJsTypeRelations(
  rootNode: Node,
  fileId: string,
  symbols: SymbolRecord[],
): TypeRelationRecord[] {
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

function extractPythonTypeRelations(
  rootNode: Node,
  fileId: string,
  symbols: SymbolRecord[],
): TypeRelationRecord[] {
  const relations: TypeRelationRecord[] = [];
  walkNodes(rootNode, (node) => {
    if (node.type !== 'class_definition') return;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text.trim();
    const owner = findSymbol(symbols, name, node.startPosition.row + 1, ['class']);
    for (const target of extractPythonBaseClasses(node.text)) {
      relations.push({
        fileId,
        fromSymbolId: owner?.id ?? null,
        relationKind: 'EXTENDS',
        targetName: target,
        targetSymbolId: null,
        evidence: `${name} extends ${target}`,
      });
    }
  });
  return relations;
}

function extractGoTypeRelations(
  rootNode: Node,
  fileId: string,
  symbols: SymbolRecord[],
): TypeRelationRecord[] {
  const source = rootNode.text;
  const interfaces = extractGoInterfaces(source);
  const receiverMethods = extractGoReceiverMethods(source);
  const relations: TypeRelationRecord[] = [];
  const seen = new Set<string>();

  for (const [receiverName, methods] of receiverMethods) {
    const receiverSymbol = findSymbolByName(symbols, receiverName, ['class']);
    if (!receiverSymbol) continue;

    for (const iface of interfaces) {
      if (iface.name === receiverName || iface.methods.length === 0) continue;
      if (!iface.methods.every((method) => methods.has(method))) continue;
      const ifaceSymbol = findSymbolByName(symbols, iface.name, ['interface']);
      const key = `${receiverSymbol.id}->${iface.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push({
        fileId,
        fromSymbolId: receiverSymbol.id,
        relationKind: 'IMPLEMENTS',
        targetName: iface.name,
        targetSymbolId: ifaceSymbol?.id ?? null,
        evidence: `${receiverName} implicitly implements ${iface.name}`,
      });
    }
  }

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

function extractPythonBaseClasses(text: string): string[] {
  const header = text.slice(0, Math.min(text.indexOf(':') >= 0 ? text.indexOf(':') : text.length, 500));
  const match = header.match(/\bclass\s+[A-Za-z_]\w*\s*\(([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim().match(/^[A-Za-z_]\w*/)?.[0] || '')
    .filter((name) => Boolean(name) && name !== 'object');
}

function extractGoInterfaces(source: string): Array<{ name: string; methods: string[] }> {
  const interfaces: Array<{ name: string; methods: string[] }> = [];
  const typeRegex = /\btype\s+([A-Za-z_]\w*)\s+interface\s*\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;
  while ((match = typeRegex.exec(source)) !== null) {
    const methods = new Set<string>();
    const methodRegex = /^\s*([A-Za-z_]\w*)\s*\(/gm;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodRegex.exec(match[2])) !== null) {
      methods.add(methodMatch[1]);
    }
    interfaces.push({ name: match[1], methods: [...methods] });
  }
  return interfaces;
}

function extractGoReceiverMethods(source: string): Map<string, Set<string>> {
  const methodsByReceiver = new Map<string, Set<string>>();
  const methodRegex = /\bfunc\s*\(\s*[A-Za-z_]\w*\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = methodRegex.exec(source)) !== null) {
    const methods = methodsByReceiver.get(match[1]) || new Set<string>();
    methods.add(match[2]);
    methodsByReceiver.set(match[1], methods);
  }
  return methodsByReceiver;
}

function findSymbol(
  symbols: SymbolRecord[],
  name: string,
  startLine: number,
  kinds: Array<SymbolRecord['kind']>,
): SymbolRecord | null {
  return symbols.find((symbol) => (
    symbol.name === name &&
    symbol.startLine === startLine &&
    kinds.includes(symbol.kind)
  )) ?? null;
}

function findSymbolByName(
  symbols: SymbolRecord[],
  name: string,
  kinds: Array<SymbolRecord['kind']>,
): SymbolRecord | null {
  return symbols.find((symbol) => symbol.name === name && kinds.includes(symbol.kind)) ?? null;
}

function walkNodes(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walkNodes(child, visit);
  }
}
