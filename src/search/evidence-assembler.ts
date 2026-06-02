import type { ContextPack, EvidenceItem, SearchResult } from '../shared/types.js';
import { estimateTokens } from '../shared/token-counter.js';

export function buildEvidence(results: SearchResult[], pack: ContextPack): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const resultByLocation = new Map<string, SearchResult>();

  for (const result of results) {
    if (result.evidence) {
      evidence.push(...result.evidence);
    }
    if (result.lineRange) {
      resultByLocation.set(
        locationKey(result.filePath, result.name, result.lineRange),
        result,
      );
    }
  }

  for (const symbol of pack.symbols) {
    const matchedResult = resultByLocation.get(locationKey(symbol.filePath, symbol.name, symbol.lineRange));
    evidence.push({
      id: matchedResult ? 'symbol:' + matchedResult.id : 'symbol:' + stableEvidenceKey(symbol.filePath, symbol.name, symbol.lineRange),
      kind: 'ast_node',
      filePath: symbol.filePath,
      startLine: symbol.lineRange[0],
      endLine: symbol.lineRange[1],
      startColumn: symbol.columnRange[0],
      endColumn: symbol.columnRange[1],
      preview: symbol.signature || symbol.name,
      confidence: matchedResult?.score ?? 0.6,
    });
  }

  for (const snippet of pack.codeSnippets) {
    evidence.push({
      id: 'chunk:' + stableEvidenceKey(snippet.filePath, snippet.symbolName || 'file', snippet.lineRange),
      kind: 'ast_node',
      filePath: snippet.filePath,
      startLine: snippet.lineRange[0],
      endLine: snippet.lineRange[1],
      startColumn: snippet.columnRange[0],
      endColumn: snippet.columnRange[1],
      preview: firstMeaningfulLine(snippet.content),
      confidence: 0.8,
    });
  }

  for (const memory of pack.relevantMemories) {
    evidence.push({
      id: 'memory:' + memory.id,
      kind: 'memory',
      preview: memory.content,
      confidence: memory.confidence,
    });
  }

  return dedupeEvidence(evidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 40);
}

export function selectEvidenceWithinBudget(
  evidence: EvidenceItem[],
  remainingBudget: number,
): EvidenceItem[] {
  const selected: EvidenceItem[] = [];
  let tokens = 0;

  for (const item of evidence) {
    const itemTokens = estimateTokens(formatEvidenceItems([item]).join('\n'));
    if (tokens + itemTokens > remainingBudget) break;
    selected.push(item);
    tokens += itemTokens;
  }

  return selected;
}

export function formatEvidenceItems(evidence: EvidenceItem[]): string[] {
  return evidence.map((item) => {
    const location = item.filePath && item.startLine && item.endLine
      ? ` ${item.filePath}:${item.startLine}-${item.endLine}`
      : '';
    const preview = item.preview ? ` — ${compactPreview(item.preview)}` : '';
    return `- ${item.kind}${location} confidence=${item.confidence.toFixed(3)}${preview}`;
  });
}

function locationKey(filePath: string, name: string, lineRange: [number, number]): string {
  return `${filePath}:${name}:${lineRange[0]}:${lineRange[1]}`;
}

function stableEvidenceKey(filePath: string, name: string, lineRange: [number, number]): string {
  return `${filePath}:${name}:${lineRange[0]}:${lineRange[1]}`;
}

function firstMeaningfulLine(content: string): string {
  return content.split('\n').map((line) => line.trim()).find(Boolean) || '';
}

function compactPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? compact.slice(0, 117) + '...' : compact;
}

function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const deduped: EvidenceItem[] = [];

  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped;
}
