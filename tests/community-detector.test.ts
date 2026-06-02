import { describe, expect, it } from 'vitest';
import {
  detectCommunities,
  type Community,
} from '../src/graph/community-detector.js';

interface Edge {
  from: string;
  to: string;
  type: string;
}

function buildTwoDisconnectedCliques(cliqueSize: number, type: string, prefixA: string, prefixB: string): { symbolIds: string[]; edges: Edge[] } {
  const symbolIds: string[] = [];
  for (let i = 0; i < cliqueSize; i++) symbolIds.push(`${prefixA}:method${i}`);
  for (let i = 0; i < cliqueSize; i++) symbolIds.push(`${prefixB}:method${i}`);
  const edges: Edge[] = [];
  for (let i = 0; i < cliqueSize; i++) {
    for (let j = i + 1; j < cliqueSize; j++) {
      edges.push({ from: `${prefixA}:method${i}`, to: `${prefixA}:method${j}`, type });
      edges.push({ from: `${prefixB}:method${i}`, to: `${prefixB}:method${j}`, type });
    }
  }
  return { symbolIds, edges };
}

function buildDenseGraph(size: number, prefix: string, type: string): { symbolIds: string[]; edges: Edge[] } {
  const symbolIds: string[] = [];
  for (let i = 0; i < size; i++) symbolIds.push(`${prefix}:method${i}`);
  const edges: Edge[] = [];
  for (let i = 0; i < symbolIds.length; i++) {
    for (let j = i + 1; j < symbolIds.length; j++) {
      edges.push({ from: symbolIds[i]!, to: symbolIds[j]!, type });
    }
  }
  return { symbolIds, edges };
}

describe('community-detector (Louvain)', () => {
  it('returns an empty result for empty input', () => {
    const result = detectCommunities([], []);
    expect(result.communities).toEqual([]);
    expect(result.totalNodes).toBe(0);
    expect(result.iterations).toBe(0);
  });

  it('returns an empty result when there are nodes but no edges', () => {
    const result = detectCommunities(['a', 'b', 'c'], []);
    expect(result.communities).toEqual([]);
    expect(result.totalNodes).toBe(3);
  });

  it('groups two disconnected 5-cliques into 2 communities', () => {
    const { symbolIds, edges } = buildTwoDisconnectedCliques(5, 'CALLS', 'authService', 'paymentService');

    const result = detectCommunities(symbolIds, edges);

    expect(result.communities).toHaveLength(2);
    const sizes = result.communities.map((c) => c.memberSymbolIds.length).sort();
    expect(sizes).toEqual([5, 5]);
    const totalMembers = result.communities.reduce((sum, c) => sum + c.memberSymbolIds.length, 0);
    expect(totalMembers).toBe(10);
  });

  it('groups a single 10-clique into 1 community with high cohesion', () => {
    const { symbolIds, edges } = buildDenseGraph(10, 'paymentService', 'CALLS');

    const result = detectCommunities(symbolIds, edges);

    expect(result.communities.length).toBeGreaterThanOrEqual(1);
    const top = result.communities[0]!;
    expect(top.memberSymbolIds.length).toBe(10);
    // Cohesion of a 10-clique: 2*45 / (10*9 + 10) = 0.9
    expect(top.cohesion).toBeGreaterThan(0.5);
  });

  it('produces a community whose cohesion is close to 1 for a dense graph', () => {
    const { symbolIds, edges } = buildDenseGraph(20, 'userService', 'CALLS');

    const result = detectCommunities(symbolIds, edges);

    const top = result.communities[0]!;
    // For a 20-clique the cohesion is (20-1)/20 = 0.95.
    expect(top.cohesion).toBeGreaterThan(0.9);
    expect(top.cohesion).toBeLessThanOrEqual(1);
  });

  it('is idempotent: re-running with the same input yields the same community ids', () => {
    const { symbolIds, edges } = buildDenseGraph(10, 'orderService', 'CALLS');

    const first = detectCommunities(symbolIds, edges);
    const second = detectCommunities(symbolIds, edges);

    const ids1 = first.communities.map((c) => c.id).sort();
    const ids2 = second.communities.map((c) => c.id).sort();
    expect(ids1).toEqual(ids2);

    const members1 = first.communities.map((c) => [...c.memberSymbolIds].sort());
    const members2 = second.communities.map((c) => [...c.memberSymbolIds].sort());
    expect(members1).toEqual(members2);
  });

  it('is stable: a small perturbation does not drastically change the number of communities', () => {
    const { symbolIds, edges } = buildDenseGraph(10, 'stableService', 'CALLS');

    const baseline = detectCommunities(symbolIds, edges);
    const perturbedEdges = [
      ...edges,
      // Add a single duplicate edge; the result should remain the same.
      { from: 'stableService:method0', to: 'stableService:method1', type: 'CALLS' },
    ];
    const perturbed = detectCommunities(symbolIds, perturbedEdges);

    expect(Math.abs(perturbed.communities.length - baseline.communities.length)).toBeLessThanOrEqual(1);
  });

  it('uses "louvain" as detection method for all communities', () => {
    const symbolIds = ['alpha:foo', 'alpha:bar', 'alpha:baz', 'beta:qux'];
    const edges: Edge[] = [
      { from: 'alpha:foo', to: 'alpha:bar', type: 'CALLS' },
      { from: 'alpha:bar', to: 'alpha:baz', type: 'CALLS' },
      { from: 'alpha:foo', to: 'alpha:baz', type: 'CALLS' },
    ];
    const result = detectCommunities(symbolIds, edges);
    for (const community of result.communities) {
      expect(community.detectionMethod).toBe('louvain');
    }
  });

  it('extracts top-5 keywords from the most common identifier tokens', () => {
    const { symbolIds, edges } = buildDenseGraph(10, 'paymentProcessor', 'CALLS');

    const result = detectCommunities(symbolIds, edges);
    const top = result.communities[0]!;
    expect(top.memberSymbolIds.length).toBe(10);
    expect(top.keywords.length).toBeLessThanOrEqual(5);
    // camelCase-split identifier should produce both 'payment' and 'processor'.
    expect(top.keywords).toContain('payment');
    expect(top.keywords).toContain('processor');
  });

  it('produces no community for a single isolated node (low cohesion filter)', () => {
    const symbolIds = ['lone:wolf'];
    const edges: Edge[] = [];
    const result = detectCommunities(symbolIds, edges);
    expect(result.communities).toEqual([]);
  });

  it('respects the minCohesion filter', () => {
    // Two nodes connected by one edge → cohesion 0.5, passes the default 0.1.
    const symbolIds = ['pair:a', 'pair:b'];
    const edges: Edge[] = [
      { from: 'pair:a', to: 'pair:b', type: 'CALLS' },
    ];
    const withFilter = detectCommunities(symbolIds, edges, { minCohesion: 0.6 });
    expect(withFilter.communities).toEqual([]);

    const withoutFilter = detectCommunities(symbolIds, edges, { minCohesion: 0.1 });
    expect(withoutFilter.communities.length).toBe(1);
  });

  it('filters out self-loop edges', () => {
    const result = detectCommunities(['a'], [{ from: 'a', to: 'a', type: 'CALLS' }]);
    expect(result.communities).toEqual([]);
    expect(result.totalNodes).toBe(1);
  });

  it('deduplicates multi-edges between the same pair of nodes', () => {
    const result = detectCommunities(
      ['a', 'b'],
      [
        { from: 'a', to: 'b', type: 'CALLS' },
        { from: 'a', to: 'b', type: 'IMPORTS' },
      ],
    );
    expect(result.communities).toHaveLength(1);
    expect(result.communities[0]!.memberSymbolIds).toHaveLength(2);
  });
});

describe('community-detector output shape', () => {
  it('returns Community objects with the expected fields', () => {
    const { symbolIds, edges } = buildDenseGraph(5, 'shaper', 'CALLS');
    const result = detectCommunities(symbolIds, edges);
    const community: Community = result.communities[0]!;
    expect(typeof community.id).toBe('string');
    expect(typeof community.name).toBe('string');
    expect(Array.isArray(community.memberSymbolIds)).toBe(true);
    expect(typeof community.cohesion).toBe('number');
    expect(Array.isArray(community.keywords)).toBe(true);
    expect(community.detectionMethod).toBe('louvain');
  });
});
