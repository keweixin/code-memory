import type { ContextDelta, ContextPack, ContextSnippet, ContextSymbol } from '../shared/types.js';

export interface PackedContextKeys {
  files: string[];
  symbols: string[];
  chunks: string[];
  evidenceIds: string[];
}

export function collectPackContext(pack: ContextPack): PackedContextKeys {
  const files = unique(pack.files.map((file) => file.path));
  const symbols = unique(pack.symbols.map(symbolKey));
  const chunks = unique(pack.codeSnippets.map(snippetKey));
  const evidenceIds = unique([
    ...symbols.map((symbol) => 'symbol:' + symbol),
    ...chunks.map((chunk) => 'chunk:' + chunk),
  ]);

  return { files, symbols, chunks, evidenceIds };
}

export function omitRepeatedContext(
  pack: ContextPack,
  delta: ContextDelta,
  sessionId: string,
): boolean {
  const newFiles = new Set(delta.newFiles);
  const newSymbols = new Set(delta.newSymbols);
  const newChunks = new Set(delta.newChunks);
  const repeatedCount =
    delta.repeatedFiles.length + delta.repeatedSymbols.length + delta.repeatedChunks.length;

  if (repeatedCount === 0) return false;

  pack.files = pack.files.filter((file) => newFiles.has(file.path));
  pack.symbols = pack.symbols.filter((symbol) => newSymbols.has(symbolKey(symbol)));
  pack.codeSnippets = pack.codeSnippets.filter((snippet) => newChunks.has(snippetKey(snippet)));
  if (pack.evidence) {
    pack.evidence = pack.evidence.filter((item) => !item.filePath || newFiles.has(item.filePath));
  }
  pack.missing.push('Repeated context omitted for session ' + sessionId + '.');
  return true;
}

function symbolKey(symbol: ContextSymbol): string {
  return [
    symbol.filePath,
    symbol.name,
    symbol.kind,
    symbol.lineRange[0],
    symbol.lineRange[1],
  ].join(':');
}

function snippetKey(snippet: ContextSnippet): string {
  return [
    snippet.filePath,
    snippet.symbolName || 'file',
    snippet.lineRange[0],
    snippet.lineRange[1],
  ].join(':');
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
