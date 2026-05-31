/**
 * Code Memory Graph — Hybrid Search
 *
 * Combines keyword search (FTS3) and graph expansion (SQLite edges)
 * using Reciprocal Rank Fusion (RRF).
 *
 * Vector search is intentionally not part of the active retrieval path yet:
 * embeddings are not generated during indexing, and query embeddings are not
 * generated at search time. Keep this honest until the full vector pipeline is
 * wired end to end.
 *
 * RRF formula: score(d) = Σ_i  w_i / (k + rank_i(d))
 * where k=60 (standard), w_i is the weight for each retrieval system.
 */

import type { Database as SqlJsDatabase } from 'sql.js';
import type {
  SearchResult,
  SearchOptions,
  SearchWeights,
  SearchSource,
  SymbolKind,
} from '../shared/types.js';
import { DEFAULT_SEARCH_WEIGHTS } from '../shared/types.js';
import { RRF_K, DEFAULT_SEARCH_LIMIT } from '../shared/constants.js';
import { searchSymbolsFts, searchFilesFts, normalizeFts3Scores } from './fts-search.js';
import { bfsExpand } from './graph-search.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hybrid-search');

export class HybridSearchEngine {
  private db: SqlJsDatabase;
  private weights: SearchWeights;
  private vectorSearchAvailable: boolean;

  constructor(
    db: SqlJsDatabase,
    weights?: SearchWeights,
    vectorSearchAvailable: boolean = false,
  ) {
    this.db = db;
    this.weights = weights || DEFAULT_SEARCH_WEIGHTS;
    this.vectorSearchAvailable = vectorSearchAvailable;
  }

  /**
   * Perform a hybrid search combining all retrieval methods.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const {
      query,
      limit = DEFAULT_SEARCH_LIMIT,
      kindFilter,
      fileFilter,
      searchMode = 'hybrid',
      weights: customWeights,
      graphHops = 2,
    } = options;

    const w = customWeights || this.weights;

    log.info(`Hybrid search: "${query}" (mode: ${searchMode}, limit: ${limit})`);

    if (searchMode === 'vector') {
      throw new Error(
        'Vector search is not available: chunk embeddings and query embeddings are not wired yet. Use keyword, graph, or hybrid mode.',
      );
    }

    // Phase 1: Collect results from each retrieval system
    let keywordResults: Array<{ id: string; rank: number }> = [];
    let vectorResults: Array<{ id: string; rank: number }> = [];
    let graphResults: Array<{ id: string; rank: number }> = [];
    let graphSeedResults: Array<{ id: string; rank: number }> = [];

    // Keyword search (FTS3)
    if (searchMode === 'hybrid' || searchMode === 'keyword' || searchMode === 'graph') {
      const ftsResults = normalizeFts3Scores(
        searchSymbolsFts(this.db, {
          query,
          limit: limit * 2,
          kindFilter,
          fileFilter,
        }),
      );
      const ranked = ftsResults.map((r, i) => ({ id: r.id, rank: i + 1 }));
      if (searchMode === 'graph') {
        graphSeedResults = ranked;
        log.info(`Graph seed search returned ${graphSeedResults.length} results`);
      } else {
        keywordResults = ranked;
        log.info(`Keyword search returned ${keywordResults.length} results`);
      }
    }

    // Vector search (LanceDB) — disabled until embeddings are generated end to end.
    if (searchMode === 'hybrid' && this.vectorSearchAvailable) {
      log.warn('Vector search requested but not wired: index chunk embeddings and query embeddings are not available yet');
    }

    // Graph expansion from top keyword/vector results
    if (searchMode === 'hybrid' || searchMode === 'graph') {
      const topIds = [
        ...(searchMode === 'graph' ? graphSeedResults : keywordResults).slice(0, 5).map((r) => r.id),
        ...vectorResults.slice(0, 5).map((r) => r.id),
      ];

      if (topIds.length > 0) {
        const graphExpanded = bfsExpand(this.db, {
          startNodeIds: topIds,
          direction: 'both',
          maxHops: graphHops,
          maxNodes: limit * 3,
        });

        // Rank graph results by distance (closer = higher rank)
        graphResults = graphExpanded
          .sort((a, b) => a.distance - b.distance)
          .map((r, i) => ({ id: r.nodeId, rank: i + 1 }));

        log.info(`Graph expansion returned ${graphResults.length} results`);
      }
    }

    // Phase 2: Reciprocal Rank Fusion
    const mergedResults = this.rrfMerge(
      keywordResults,
      vectorResults,
      graphResults,
      w,
    );

    // Phase 3: Enrich results with metadata from SQLite
    const enriched = this.enrichResults(mergedResults, limit);

    return enriched;
  }

  /**
   * Search symbols specifically.
   */
  async searchSymbols(
    query: string,
    options: { kind?: SymbolKind; limit?: number } = {},
  ): Promise<SearchResult[]> {
    return this.search({
      query,
      limit: options.limit || DEFAULT_SEARCH_LIMIT,
      kindFilter: options.kind,
      searchMode: 'hybrid',
    });
  }

  /**
   * Search code (file content + symbols).
   */
  async searchCode(
    query: string,
    options: { limit?: number; fileFilter?: string; searchMode?: 'hybrid' | 'keyword' | 'graph' } = {},
  ): Promise<SearchResult[]> {
    // First search symbols
    const symbolResults = await this.search({
      query,
      limit: options.limit || DEFAULT_SEARCH_LIMIT,
      fileFilter: options.fileFilter,
      searchMode: options.searchMode || 'hybrid',
    });

    // Also search file contents via FTS5
    const fileResults = options.searchMode === 'graph'
      ? []
      : searchFilesFts(this.db, query, options.limit || DEFAULT_SEARCH_LIMIT);

    // Merge and deduplicate
    const seen = new Set(symbolResults.map((r) => r.id));
    const combined = [...symbolResults];

    for (const fr of fileResults) {
      if (!seen.has(fr.id)) {
        seen.add(fr.id);
        combined.push({
          id: fr.id,
          name: fr.name,
          kind: 'file' as const,
          filePath: fr.filePath,
          score: fr.score * this.weights.keyword, // Adjust score
          sources: ['keyword'] as SearchSource[],
          snippet: fr.snippet,
          lineRange: null,
          columnRange: null,
        });
      }
    }

    // Re-sort by score
    combined.sort((a, b) => b.score - a.score);
    return combined.slice(0, options.limit || DEFAULT_SEARCH_LIMIT);
  }

  /**
   * RRF merge: Combine results from multiple retrieval systems
   * using Reciprocal Rank Fusion.
   */
  private rrfMerge(
    keywordResults: Array<{ id: string; rank: number }>,
    vectorResults: Array<{ id: string; rank: number }>,
    graphResults: Array<{ id: string; rank: number }>,
    weights: SearchWeights,
  ): Array<{ id: string; score: number; sources: SearchSource[] }> {
    const scores = new Map<string, { score: number; sources: Set<SearchSource> }>();

    // Process keyword results
    for (const { id, rank } of keywordResults) {
      const existing = scores.get(id) || { score: 0, sources: new Set<SearchSource>() };
      existing.score += weights.keyword / (RRF_K + rank);
      existing.sources.add('keyword');
      scores.set(id, existing);
    }

    // Process vector results
    for (const { id, rank } of vectorResults) {
      const existing = scores.get(id) || { score: 0, sources: new Set<SearchSource>() };
      existing.score += weights.vector / (RRF_K + rank);
      existing.sources.add('vector');
      scores.set(id, existing);
    }

    // Process graph results
    for (const { id, rank } of graphResults) {
      const existing = scores.get(id) || { score: 0, sources: new Set<SearchSource>() };
      existing.score += weights.graph / (RRF_K + rank);
      existing.sources.add('graph');
      scores.set(id, existing);
    }

    // Sort by score descending
    return Array.from(scores.entries())
      .map(([id, { score, sources }]) => ({
        id,
        score,
        sources: [...sources],
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Enrich merged results with metadata from the SQLite database.
   */
  private enrichResults(
    merged: Array<{ id: string; score: number; sources: SearchSource[] }>,
    limit: number,
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (const item of merged.slice(0, limit)) {
      // Try to find in symbols table first
      try {
        const symResults = this.db.exec(
          `SELECT name, kind, file_id, start_line, end_line, start_column, end_column
           FROM symbols WHERE id = ?`,
          [item.id],
        );

        if (symResults.length > 0 && symResults[0].values.length > 0) {
          const row = symResults[0].values[0];
          // Get file path
          const filePathResult = this.db.exec(
            'SELECT path FROM files WHERE id = ?',
            [String(row[2])],
          );
          const filePath = filePathResult.length > 0 && filePathResult[0].values.length > 0
            ? String(filePathResult[0].values[0][0])
            : String(row[2]);

          results.push({
            id: item.id,
            name: String(row[0]),
            kind: String(row[1]) as SymbolKind,
            filePath,
            score: item.score,
            sources: item.sources,
            snippet: null,
            lineRange: [Number(row[3]), Number(row[4])],
            columnRange: [Number(row[5]), Number(row[6])],
          });
          continue;
        }
      } catch {
        // Not a symbol, try as file
      }

      // Try as file
      try {
        const fileResults = this.db.exec(
          'SELECT path, language FROM files WHERE id = ?',
          [item.id],
        );

        if (fileResults.length > 0 && fileResults[0].values.length > 0) {
          const row = fileResults[0].values[0];
          results.push({
            id: item.id,
            name: String(row[0]).split('/').pop() || String(row[0]),
            kind: 'file',
            filePath: String(row[0]),
            score: item.score,
            sources: item.sources,
            snippet: null,
            lineRange: null,
            columnRange: null,
          });
          continue;
        }
      } catch {
        // Not a file either
      }

      // Fallback: use ID as name
      results.push({
        id: item.id,
        name: item.id,
        kind: 'file',
        filePath: '',
        score: item.score,
        sources: item.sources,
        snippet: null,
        lineRange: null,
        columnRange: null,
      });
    }

    return results;
  }
}
