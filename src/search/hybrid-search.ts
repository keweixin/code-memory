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
  ToolDiagnostics,
  SearchIntent,
} from '../shared/types.js';
import { DEFAULT_SEARCH_WEIGHTS } from '../shared/types.js';
import { RRF_K, DEFAULT_SEARCH_LIMIT } from '../shared/constants.js';
import { SCHEMA_VERSION } from '../storage/schema.js';
import { searchSymbolsFts, searchFilesFts, normalizeFts5Scores } from './fts-search.js';
import { bfsExpand } from './graph-search.js';
import { classifySearchIntent, getIntentGraphProfile } from './intent-router.js';
import type { VectorSearchProvider } from './vector-search.js';
import { rrfMerge } from './rrf-fusion.js';
import { enrichSearchResults } from './result-enricher.js';
import { applyLedgerPenalties } from './ledger-reranker.js';
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
      intent,
      sessionId,
      avoidRepeated = false,
    } = options;

    const w = customWeights || this.weights;
    const intentClassification = classifySearchIntent(query, intent);
    const graphProfile = getIntentGraphProfile(intentClassification.intent);
    const shouldApplyLedgerPenalty = Boolean(sessionId && avoidRepeated);
    const candidateLimit = shouldApplyLedgerPenalty ? Math.max(limit * 3, limit) : limit;

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
          limit: candidateLimit * 2,
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
        limit: candidateLimit * 2,
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
          intent: graphProfile ? intentClassification.intent : undefined,
          maxHops: graphHops,
          maxNodes: candidateLimit * 3,
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
    const mergedResults = rrfMerge(
      keywordResults,
      vectorResults,
      graphResults,
      w,
    );

    // Phase 3: Enrich results with metadata from SQLite
    const diagnostics = (shouldApplyLedgerPenalty || (graphProfile && (searchMode === 'hybrid' || searchMode === 'graph')))
      ? {
          schemaVersion: SCHEMA_VERSION,
          vectorUsed: vectorResults.length > 0,
          graphUsed: graphResults.length > 0,
          repeatedContextOmitted: 0,
          intent: intentClassification.intent,
          intentHints: intentClassification.matchedHints,
          ...(graphProfile ? { graphProfile } : {}),
    } satisfies ToolDiagnostics
      : undefined;
    const enrichLimit = kindFilter ? Math.max(candidateLimit * 4, candidateLimit) : candidateLimit;
    const enriched = enrichSearchResults(this.db, mergedResults, enrichLimit, diagnostics)
      .filter((result) => !kindFilter || result.kind === kindFilter);
    const penalized = applyLedgerPenalties(this.db, enriched, { sessionId, avoidRepeated });
    for (const result of penalized.results) {
      if (result.diagnostics) {
        result.diagnostics.repeatedContextPenalized = penalized.penalizedResults;
        result.diagnostics.totalPriorContextTokens = penalized.totalPriorTokens;
      }
    }

    return penalized.results.slice(0, limit);
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
    options: {
      limit?: number;
      fileFilter?: string;
      searchMode?: 'hybrid' | 'keyword' | 'vector' | 'graph';
      intent?: SearchIntent;
      sessionId?: string;
      avoidRepeated?: boolean;
    } = {},
  ): Promise<SearchResult[]> {
    const limit = options.limit || DEFAULT_SEARCH_LIMIT;
    const shouldApplyLedgerPenalty = Boolean(options.sessionId && options.avoidRepeated);
    const candidateLimit = shouldApplyLedgerPenalty ? Math.max(limit * 3, limit) : limit;

    // First search symbols
    const symbolResults = await this.search({
      query,
      limit: candidateLimit,
      fileFilter: options.fileFilter,
      searchMode: options.searchMode || 'hybrid',
      intent: options.intent,
    });

    // Also search file contents via FTS5
    const fileResults = options.searchMode === 'graph' || options.searchMode === 'vector'
      ? []
      : searchFilesFts(this.db, query, candidateLimit, options.fileFilter);

    // Merge and deduplicate
    const seen = new Set(symbolResults.map((r) => r.id));
    const combined = [...symbolResults];

    for (const [index, fr] of fileResults.entries()) {
      if (!seen.has(fr.id)) {
        seen.add(fr.id);
        const keywordRank = index + 1;
        const rrfKeyword = this.weights.keyword / (RRF_K + keywordRank);
        combined.push({
          id: fr.id,
          name: fr.name,
          kind: 'file' as const,
          filePath: fr.filePath,
          score: rrfKeyword,
          sources: ['keyword'] as SearchSource[],
          snippet: fr.snippet,
          lineRange: null,
          columnRange: null,
          scoreBreakdown: {
            keywordRank,
            rrfKeyword,
            keyword: rrfKeyword,
            finalScore: rrfKeyword,
          },
        });
      }
    }

    // Re-sort by score
    combined.sort((a, b) => b.score - a.score);
    const penalized = applyLedgerPenalties(this.db, combined, {
      sessionId: options.sessionId,
      avoidRepeated: options.avoidRepeated,
    });
    return penalized.results.slice(0, limit);
  }
}
