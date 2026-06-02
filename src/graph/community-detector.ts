/**
 * Code Memory Graph — Community Detector
 *
 * Lightweight Louvain-style community detection over the symbol graph.
 *
 * The algorithm operates on the *undirected* projection of typed edges
 * (CALLS, IMPORTS, EXTENDS). Each iteration, every node is tentatively
 * moved to the neighbouring community that maximises modularity gain.
 * Once the pass produces no moves, the algorithm stops. The implementation
 * is intentionally simple — it is not a full multi-level Louvain refinement,
 * but it is good enough to group tightly-coupled symbols together.
 *
 * External graph libraries are intentionally avoided. The whole detector
 * runs in O(iterations * edges) and is safe for tens of thousands of
 * symbols on commodity hardware.
 */

export interface CommunityDetectionOptions {
  /** Maximum Louvain outer iterations. Default: 10. */
  maxIterations?: number;
  /** Drop communities whose cohesion is below this threshold. Default: 0.1. */
  minCohesion?: number;
  /** Louvain resolution parameter (higher → more communities). Default: 1.0. */
  resolution?: number;
}

export interface Community {
  id: string;
  /** Auto-generated name, usually the most common token among member names. */
  name: string;
  memberSymbolIds: string[];
  /** 0..1 — fraction of possible internal edges that exist inside the community. */
  cohesion: number;
  /** Top 5 most common tokens across the member symbol names. */
  keywords: string[];
  detectionMethod: 'louvain' | 'leiden';
}

export interface CommunityDetectionResult {
  communities: Community[];
  totalNodes: number;
  iterations: number;
}

interface CommunityEdge {
  from: string;
  to: string;
  type: string;
}

/**
 * Detect communities in a graph defined by symbol IDs and undirected edges.
 */
export function detectCommunities(
  symbolIds: string[],
  edges: CommunityEdge[],
  options: CommunityDetectionOptions = {},
): CommunityDetectionResult {
  const maxIterations = Math.max(1, Math.floor(options.maxIterations ?? 10));
  const minCohesion = options.minCohesion ?? 0.1;
  const resolution = options.resolution ?? 1.0;

  if (symbolIds.length === 0) {
    return { communities: [], totalNodes: 0, iterations: 0 };
  }

  const idIndex = new Map<string, number>();
  for (let i = 0; i < symbolIds.length; i++) {
    idIndex.set(symbolIds[i]!, i);
  }

  // Deduplicate and normalise edges to an undirected lower-index/upper-index pair.
  const pairSet = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const edge of edges) {
    const a = idIndex.get(edge.from);
    const b = idIndex.get(edge.to);
    if (a === undefined || b === undefined) continue;
    if (a === b) continue;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * symbolIds.length + hi;
    if (pairSet.has(key)) continue;
    pairSet.add(key);
    pairs.push([lo, hi]);
  }

  if (pairs.length === 0) {
    // No edges → communities cannot be defined; return an empty result
    // so the caller can still see that something was processed.
    return { communities: [], totalNodes: symbolIds.length, iterations: 0 };
  }

  const n = symbolIds.length;
  const m2 = pairs.length * 2;
  const degree = new Float64Array(n);

  // Build CSR-style adjacency by sorting pairs and counting per-node degree.
  pairs.sort((p1, p2) => p1[0] - p2[0] || p1[1] - p2[1]);
  for (const [a, b] of pairs) {
    degree[a]! += 1;
    degree[b]! += 1;
  }

  const neighborOffsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    neighborOffsets[i + 1] = neighborOffsets[i]! + Math.round(degree[i]!);
  }
  const neighborList = new Int32Array(neighborOffsets[n]!);
  const cursor = new Int32Array(n);
  for (const [a, b] of pairs) {
    neighborList[neighborOffsets[a]! + cursor[a]!] = b;
    cursor[a]! += 1;
    neighborList[neighborOffsets[b]! + cursor[b]!] = a;
    cursor[b]! += 1;
  }

  // Each node starts in its own community.
  const nodeCommunity = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeCommunity[i] = i;

  const communityTot = new Float64Array(n);
  for (let i = 0; i < n; i++) communityTot[i] = degree[i]!;

  let iterations = 0;
  let improved = true;
  const communityEdges = new Map<number, number>();
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations += 1;

    for (let i = 0; i < n; i++) {
      const currentCommunity = nodeCommunity[i]!;
      const start = neighborOffsets[i]!;
      const end = neighborOffsets[i + 1]!;
      if (start === end) continue;

      communityEdges.clear();
      for (let k = start; k < end; k++) {
        const neighborIdx = neighborList[k]!;
        const c = nodeCommunity[neighborIdx]!;
        communityEdges.set(c, (communityEdges.get(c) ?? 0) + 1);
      }

      const selfEdges = communityEdges.get(currentCommunity) ?? 0;
      const ki = degree[i]!;
      const m = m2 / 2;
      const mSquared = m * m;
      // Two-times the resolution parameter applied to the degree-squared
      // term. We follow the standard Louvain formulation.
      const resolutionTimes2 = 2 * resolution;

      let bestCommunity = currentCommunity;
      let bestGain = 0;
      for (const [c, kic] of communityEdges) {
        if (c === currentCommunity) continue;
        const sigmaTot = communityTot[c]!;
        const currentTot = communityTot[currentCommunity]!;
        // Full modularity gain for moving node i from r to s:
        //   ΔQ = (k_i,s − k_i,r)/m − resolution × ki × (Σtot_s − Σtot_r) / (2m²) − resolution × ki² / (2m²)
        // The last term is the "self-penalty" of leaving a community — it
        // prevents the algorithm from collapsing all singletons into a
        // single community unless the edge count is large enough.
        const gain = (kic - selfEdges) / m
          - resolution * ki * (sigmaTot - currentTot) / resolutionTimes2 / mSquared
          - resolution * (ki * ki) / resolutionTimes2 / mSquared;
        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = c;
        }
      }

      if (bestCommunity !== currentCommunity) {
        communityTot[currentCommunity] -= ki;
        communityTot[bestCommunity] += ki;
        nodeCommunity[i] = bestCommunity;
        improved = true;
      }
    }
  }

  // Collapse distinct community IDs to a dense range, preserving insertion order.
  const communityIdMap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = nodeCommunity[i]!;
    if (!communityIdMap.has(c)) communityIdMap.set(c, communityIdMap.size);
    nodeCommunity[i] = communityIdMap.get(c)!;
  }

  const finalCommunityCount = communityIdMap.size;
  const finalMembers: string[][] = Array.from({ length: finalCommunityCount }, () => []);
  for (let i = 0; i < n; i++) {
    finalMembers[nodeCommunity[i]!]!.push(symbolIds[i]!);
  }

  // Count internal edges per community for cohesion.
  const internalEdges = new Int32Array(finalCommunityCount);
  for (const [a, b] of pairs) {
    const ca = nodeCommunity[a]!;
    const cb = nodeCommunity[b]!;
    if (ca === cb) internalEdges[ca]++;
  }

  const communities: Community[] = [];
  for (let c = 0; c < finalCommunityCount; c++) {
    const memberIds = finalMembers[c]!;
    const size = memberIds.length;
    if (size === 0) continue;

    const internal = internalEdges[c]!;
    // 2 * internalEdges / (size * (size - 1) + size) per the spec:
    // the +size term matches the "size" in the spec's formula.
    const denominator = size * (size - 1) + size;
    const cohesion = denominator === 0 ? 0 : (2 * internal) / denominator;

    if (cohesion < minCohesion) continue;

    const keywordCounts = countKeywordTokens(memberIds);
    const keywords = topKeywords(keywordCounts, 5);
    const name = keywords[0] ?? `community-${c + 1}`;

    communities.push({
      id: name,
      name,
      memberSymbolIds: memberIds,
      cohesion: clamp01(cohesion),
      keywords,
      detectionMethod: 'louvain',
    });
  }

  // Sort largest first for stable output across runs.
  communities.sort((a, b) => b.memberSymbolIds.length - a.memberSymbolIds.length);

  return { communities, totalNodes: symbolIds.length, iterations };
}

// ── Helpers ──────────────────────────────────────────────────

const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that',
  'function', 'class', 'method', 'const', 'let', 'var', 'new',
  'return', 'value', 'values', 'item', 'items', 'type', 'types',
  'id', 'ids', 'idx', 'index', 'name', 'names', 'data', 'result',
  'results', 'default', 'self', 'other', 'true', 'false', 'null',
  'undefined', 'module', 'export', 'import', 'async', 'await',
  'void', 'string', 'number', 'boolean', 'array', 'object',
]);

function countKeywordTokens(memberIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of memberIds) {
    const tokens = splitSymbolIdentifier(id);
    for (const token of tokens) {
      if (token.length < 3) continue;
      if (STOP_TOKENS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

function splitSymbolIdentifier(id: string): string[] {
  const tokens: string[] = [];
  const segments = id.split(/[^A-Za-z0-9]+/g).filter(Boolean);
  for (const segment of segments) {
    const parts = segment
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
      .filter(Boolean);
    for (const part of parts) tokens.push(part.toLowerCase());
  }
  return tokens;
}

function topKeywords(counts: Map<string, number>, limit: number): string[] {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return sorted.slice(0, limit).map(([token]) => token);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
