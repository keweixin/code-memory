import type { ScoreBreakdown, SearchSource, SearchWeights } from '../shared/types.js';
import { RRF_K } from '../shared/constants.js';

export interface RankedRetrieval {
  id: string;
  rank: number;
}

export interface FusedSearchItem {
  id: string;
  score: number;
  sources: SearchSource[];
  scoreBreakdown: ScoreBreakdown;
}

export function rrfMerge(
  keywordResults: RankedRetrieval[],
  vectorResults: RankedRetrieval[],
  graphResults: RankedRetrieval[],
  weights: SearchWeights,
): FusedSearchItem[] {
  const scores = new Map<string, { score: number; sources: Set<SearchSource>; scoreBreakdown: ScoreBreakdown }>();

  addRankedScores(scores, 'keyword', keywordResults, weights.keyword);
  addRankedScores(scores, 'vector', vectorResults, weights.vector);
  addRankedScores(scores, 'graph', graphResults, weights.graph);

  return Array.from(scores.entries())
    .map(([id, { score, sources, scoreBreakdown }]) => ({
      id,
      score,
      sources: [...sources],
      scoreBreakdown: {
        ...scoreBreakdown,
        finalScore: score,
      },
    }))
    .sort(compareFusedItems);
}

function addRankedScores(
  scores: Map<string, { score: number; sources: Set<SearchSource>; scoreBreakdown: ScoreBreakdown }>,
  source: SearchSource,
  results: RankedRetrieval[],
  weight: number,
): void {
  for (const { id, rank } of results) {
    const existing = scores.get(id) || { score: 0, sources: new Set<SearchSource>(), scoreBreakdown: {} };
    const score = weight / (RRF_K + rank);
    existing.score += score;
    addScoreBreakdown(existing.scoreBreakdown, source, rank, score);
    existing.sources.add(source);
    scores.set(id, existing);
  }
}

function addScoreBreakdown(
  scoreBreakdown: ScoreBreakdown,
  source: SearchSource,
  rank: number,
  score: number,
): void {
  if (source === 'keyword') {
    scoreBreakdown.keywordRank = scoreBreakdown.keywordRank ? Math.min(scoreBreakdown.keywordRank, rank) : rank;
    scoreBreakdown.rrfKeyword = (scoreBreakdown.rrfKeyword ?? 0) + score;
    scoreBreakdown.keyword = (scoreBreakdown.keyword ?? 0) + score;
    return;
  }

  if (source === 'vector') {
    scoreBreakdown.vectorRank = scoreBreakdown.vectorRank ? Math.min(scoreBreakdown.vectorRank, rank) : rank;
    scoreBreakdown.rrfVector = (scoreBreakdown.rrfVector ?? 0) + score;
    scoreBreakdown.vector = (scoreBreakdown.vector ?? 0) + score;
    return;
  }

  scoreBreakdown.graphRank = scoreBreakdown.graphRank ? Math.min(scoreBreakdown.graphRank, rank) : rank;
  scoreBreakdown.rrfGraph = (scoreBreakdown.rrfGraph ?? 0) + score;
  scoreBreakdown.graph = (scoreBreakdown.graph ?? 0) + score;
}

function compareFusedItems(a: FusedSearchItem, b: FusedSearchItem): number {
  const aPrimary = a.sources.includes('keyword') || a.sources.includes('vector');
  const bPrimary = b.sources.includes('keyword') || b.sources.includes('vector');
  if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
  return b.score - a.score;
}
