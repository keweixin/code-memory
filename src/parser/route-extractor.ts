import type { RouteEndpointRecord, RouteReferenceRecord, SymbolRecord } from '../shared/types.js';
import { ParserLanguage } from './types.js';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

export function extractRouteEndpoints(
  sourceCode: string,
  filePath: string,
  fileId: string,
  symbols: SymbolRecord[],
  lang: ParserLanguage,
): RouteEndpointRecord[] {
  return [
    ...extractNextAppRouterEndpoints(filePath, fileId, symbols),
    ...extractFastApiEndpoints(sourceCode, fileId, symbols, lang),
  ];
}

export function extractRouteReferences(
  sourceCode: string,
  fileId: string,
  symbols: SymbolRecord[],
  lang: ParserLanguage,
): RouteReferenceRecord[] {
  if (
    lang !== ParserLanguage.TypeScript &&
    lang !== ParserLanguage.TSX &&
    lang !== ParserLanguage.JavaScript &&
    lang !== ParserLanguage.JSX
  ) {
    return [];
  }

  const references: RouteReferenceRecord[] = [];
  const fetchRegex = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1([\s\S]{0,500}?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = fetchRegex.exec(sourceCode)) !== null) {
    const routePath = normalizeRoutePath(match[2]);
    if (!routePath) continue;
    const line = lineFromOffset(sourceCode, match.index);
    const caller = findEnclosingSymbol(symbols, line);
    references.push({
      fileId,
      callerSymbolId: caller?.id ?? null,
      routePath,
      httpMethod: extractFetchMethod(match[3]) || 'GET',
      framework: 'fetch',
      startLine: line,
      startColumn: columnFromOffset(sourceCode, match.index),
      evidence: sourceCode.slice(match.index, Math.min(match.index + match[0].length, match.index + 220)),
    });
  }
  return references;
}

function extractNextAppRouterEndpoints(
  filePath: string,
  fileId: string,
  symbols: SymbolRecord[],
): RouteEndpointRecord[] {
  const routePath = routePathFromNextAppFile(filePath);
  if (!routePath) return [];

  return symbols
    .filter((symbol) => HTTP_METHODS.has(symbol.name.toUpperCase()))
    .map((symbol) => ({
      fileId,
      symbolId: symbol.id,
      routePath,
      httpMethod: symbol.name.toUpperCase(),
      framework: 'next_app_router' as const,
      startLine: symbol.startLine,
      startColumn: symbol.startColumn,
      evidence: `${symbol.name.toUpperCase()} ${routePath}`,
    }));
}

function extractFastApiEndpoints(
  sourceCode: string,
  fileId: string,
  symbols: SymbolRecord[],
  lang: ParserLanguage,
): RouteEndpointRecord[] {
  if (lang !== ParserLanguage.Python) return [];

  const endpoints: RouteEndpointRecord[] = [];
  const decoratorRegex = /@[\w.]+\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"])([^'"]+)\2[^\n]*\)\s*\r?\n\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = decoratorRegex.exec(sourceCode)) !== null) {
    const routePath = normalizeRoutePath(match[3]);
    if (!routePath) continue;
    const method = match[1].toUpperCase();
    const functionName = match[4];
    const line = lineFromOffset(sourceCode, match.index);
    const symbol = findSymbolByNameAfterLine(symbols, functionName, line);
    endpoints.push({
      fileId,
      symbolId: symbol?.id ?? null,
      routePath,
      httpMethod: method,
      framework: 'fastapi',
      startLine: line,
      startColumn: columnFromOffset(sourceCode, match.index),
      evidence: `${method} ${routePath}`,
    });
  }
  return endpoints;
}

function routePathFromNextAppFile(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(?:src\/)?app\/api(?:\/(.+))?\/route\.[cm]?[jt]sx?$/);
  if (!match) return null;
  const rawSegments = (match[1] || '').split('/').filter(Boolean);
  const routeSegments = rawSegments
    .filter((segment) => !segment.startsWith('(') || !segment.endsWith(')'))
    .map((segment) => {
      const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
      if (optionalCatchAll) return `:${optionalCatchAll[1]}*`;
      const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
      if (catchAll) return `:${catchAll[1]}*`;
      const dynamic = segment.match(/^\[(.+)\]$/);
      return dynamic ? `:${dynamic[1]}` : segment;
    });
  return normalizeRoutePath(['/api', ...routeSegments].join('/'));
}

function normalizeRoutePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let path = trimmed;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  if (!path.startsWith('/')) return null;
  path = path.split(/[?#]/, 1)[0] || '/';
  path = path.replace(/\/+/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  return path;
}

function extractFetchMethod(optionsText: string): string | null {
  const match = optionsText.match(/\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/i);
  if (!match) return null;
  const method = match[2].toUpperCase();
  return HTTP_METHODS.has(method) ? method : null;
}

function findEnclosingSymbol(symbols: SymbolRecord[], line: number): SymbolRecord | null {
  return symbols
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0] ?? null;
}

function findSymbolByNameAfterLine(symbols: SymbolRecord[], name: string, line: number): SymbolRecord | null {
  return symbols
    .filter((symbol) => symbol.name === name && symbol.startLine >= line)
    .sort((a, b) => a.startLine - b.startLine)[0] ?? null;
}

function lineFromOffset(sourceCode: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (sourceCode.charCodeAt(i) === 10) line++;
  }
  return line;
}

function columnFromOffset(sourceCode: string, offset: number): number {
  const previousNewline = sourceCode.lastIndexOf('\n', offset - 1);
  return previousNewline < 0 ? offset : offset - previousNewline - 1;
}
