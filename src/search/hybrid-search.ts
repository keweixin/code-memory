/**
 * Code Memory Graph — Hybrid Search
 *
 * Combines keyword search (FTS), optional LanceDB vector search, and graph
 * expansion using Reciprocal Rank Fusion (RRF).
 *
 * RRF formula: score(d) = Σ_i  w_i / (k + rank_i(d))
 * where k=60 (standard), w_i is the weight for each retrieval system.
 */

import type { SqlJsDatabase } from '../storage/database.js';
import type {
  SearchResult,
  SearchOptions,
  SearchWeights,
  SearchSource,
  SymbolKind,
} from '../shared/types.js';
import { DEFAULT_SEARCH_WEIGHTS } from '../shared/types.js';
import { RRF_K, DEFAULT_SEARCH_LIMIT } from '../shared/constants.js';
import { searchSymbolsFts, searchFilesFts, normalizeFts5Scores } from './fts-search.js';
import { bfsExpand } from './graph-search.js';
import type { VectorSearchProvider } from './vector-search.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hybrid-search');

export class HybridSearchEngine {
  private db: SqlJsDatabase;
  private weights: SearchWeights;
  private vectorSearchProvider: VectorSearchProvider | null;

  constructor(
    db: SqlJsDatabase,
    weights?: SearchWeights,
    vectorSearch?: boolean | VectorSearchProvider,
  ) {
    this.db = db;
    this.weights = weights || DEFAULT_SEARCH_WEIGHTS;
    this.vectorSearchProvider = typeof vectorSearch === 'object' ? vectorSearch : null;
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

    const vectorSearchAvailable = this.vectorSearchProvider?.isAvailable() === true;

    if (searchMode === 'vector' && !vectorSearchAvailable) {
      throw new Error(
        'Vector search is not available: configure an embedding provider, run code-memory index --full, and ensure the provider is reachable. Use keyword, graph, or hybrid mode without vectors.',
      );
    }

    // Phase 1: Collect results from each retrieval system
    let keywordResults: Array<{ id: string; rank: number }> = [];
    let vectorResults: Array<{ id: string; rank: number }> = [];
    let graphResults: Array<{ id: string; rank: number }> = [];
    let graphSeedResults: Array<{ id: string; rank: number }> = [];

    // Keyword search (FTS5)
    if (searchMode === 'hybrid' || searchMode === 'keyword' || searchMode === 'graph') {
      const ftsResults = normalizeFts5Scores(
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

    // Vector search (LanceDB) is active only when an embedding-backed provider
    // is available for the current indexed project.
    if ((searchMode === 'hybrid' || searchMode === 'vector') && vectorSearchAvailable) {
      vectorResults = await this.vectorSearchProvider!.search(query, {
        limit: limit * 2,
        kindFilter,
        fileFilter,
      });
      log.info(`Vector search returned ${vectorResults.length} results`);
    } else if (searchMode === 'hybrid') {
      log.debug('Vector search skipped: no vector provider is available');
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
      } else if (searchMode === 'graph') {
        log.info('Graph search has no FTS seed results; returning no graph candidates.');
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
    options: { limit?: number; fileFilter?: string; searchMode?: 'hybrid' | 'keyword' | 'vector' | 'graph' } = {},
  ): Promise<SearchResult[]> {
    // First search symbols
    const symbolResults = await this.search({
      query,
      limit: options.limit || DEFAULT_SEARCH_LIMIT,
      fileFilter: options.fileFilter,
      searchMode: options.searchMode || 'hybrid',
    });

    // Also search file contents via FTS5
    const fileResults = options.searchMode === 'graph' || options.searchMode === 'vector'
      ? []
      : searchFilesFts(this.db, query, options.limit || DEFAULT_SEARCH_LIMIT, options.fileFilter);

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
    const topItems = merged.slice(0, limit);
    if (topItems.length === 0) return [];

    const topIds = topItems.map((item) => item.id);
    const placeholders = topIds.map(() => '?').join(',');
    const symbolRows = this.db.all<{
      id: string;
      name: string;
      kind: string;
      filePath: string;
      startLine: number;
      endLine: number;
      startColumn: number;
      endColumn: number;
    }>(
      `SELECT s.id AS id,
              s.name AS name,
              s.kind AS kind,
              f.path AS filePath,
              s.start_line AS startLine,
              s.end_line AS endLine,
              s.start_column AS startColumn,
              s.end_column AS endColumn
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.id IN (${placeholders})`,
      topIds,
    );
    const symbolsById = new Map(symbolRows.map((row) => [String(row.id), row]));

    const fileRows = this.db.all<{ id: string; path: string; language: string }>(
      `SELECT id, path, language FROM files WHERE id IN (${placeholders})`,
      topIds,
    );
    const filesById = new Map(fileRows.map((row) => [String(row.id), row]));

    const results: SearchResult[] = [];

    for (const item of topItems) {
      const symbol = symbolsById.get(item.id);
      if (symbol) {
        results.push({
          id: item.id,
          name: String(symbol.name),
          kind: String(symbol.kind) as SymbolKind,
          filePath: String(symbol.filePath),
          score: item.score,
          sources: item.sources,
          snippet: null,
          lineRange: [Number(symbol.startLine), Number(symbol.endLine)],
          columnRange: [Number(symbol.startColumn), Number(symbol.endColumn)],
        });
        continue;
      }

      const file = filesById.get(item.id);
      if (file) {
        const path = String(file.path);
        results.push({
          id: item.id,
          name: path.split('/').pop() || path,
          kind: 'file',
          filePath: path,
          score: item.score,
          sources: item.sources,
          snippet: null,
          lineRange: null,
          columnRange: null,
        });
        continue;
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
