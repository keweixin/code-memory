/**
 * Code Memory Graph — Context Packer
 *
 * Takes search results and packs them into a token-budgeted
 * context pack with L0-L5 layers.
 *
 * L0: Project identity card (200-500 tokens)
 * L1: Repo map — file structure + exports (500-1500 tokens)
 * L2: Relevant file/symbol list (1000-3000 tokens)
 * L3: Function signatures + summaries (2000-6000 tokens)
 * L4: Precise code snippets (4000-12000 tokens)
 * L5: Full file (on demand only)
 */

import type { SqlJsDatabase } from '../storage/database.js';
import type {
  ContextPack,
  ContextLevel,
  ContextFile,
  ContextSymbol,
  ContextSnippet,
  ProjectCard,
  MemoryRecord,
  SearchResult,
  Language,
  TokenBudgets,
  SymbolKind,
} from '../shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../shared/types.js';
import { estimateTokens } from '../shared/token-counter.js';
import { createLogger } from '../shared/logger.js';
import { resolveContextLevel } from './context-budget.js';
import { buildEvidence, formatEvidenceItems, selectEvidenceWithinBudget } from './evidence-assembler.js';

const log = createLogger('context-packer');

export class ContextPacker {
  private db: SqlJsDatabase;
  private budgets: TokenBudgets;

  constructor(db: SqlJsDatabase, budgets?: TokenBudgets) {
    this.db = db;
    this.budgets = budgets || DEFAULT_TOKEN_BUDGETS;
  }

  /**
   * Pack search results into a context pack within the given token budget.
   */
  async pack(
    query: string,
    searchResults: SearchResult[],
    options: {
      tokenBudget: number;
      includeProjectCard?: boolean;
      includeMemories?: boolean;
      maxLevel?: ContextLevel;
    },
  ): Promise<ContextPack> {
    const { tokenBudget, includeProjectCard = true, includeMemories = true, maxLevel } = options;

    log.info(`Packing context for "${query}" with budget ${tokenBudget}`);

    let tokensUsed = 0;
    const pack: ContextPack = {
      query,
      tokenBudget,
      tokensUsed: 0,
      level: 'L0',
      projectCard: null,
      relevantMemories: [],
      files: [],
      symbols: [],
      codeSnippets: [],
      callChains: [],
      missing: [],
      evidence: [],
    };

    // Determine the maximum context level we can afford
    const level = resolveContextLevel(tokenBudget, this.budgets, maxLevel);
    pack.level = level;

    // L0: Project card
    if (includeProjectCard && tokensUsed < tokenBudget) {
      const card = this.getProjectCard();
      if (card) {
        const cardTokens = estimateTokens(this.formatProjectCard(card));
        if (tokensUsed + cardTokens <= tokenBudget) {
          pack.projectCard = card;
          tokensUsed += cardTokens;
        }
      }
    }

    // Memories
    if (includeMemories && tokensUsed < tokenBudget) {
      const memories = this.getRelevantMemories(query, searchResults);
      for (const memory of memories) {
        const memTokens = estimateTokens(memory.content);
        if (tokensUsed + memTokens <= tokenBudget) {
          pack.relevantMemories.push(memory);
          tokensUsed += memTokens;
        }
      }
    }

    // L1: File list with roles and exports
    if (tokensUsed < tokenBudget) {
      const files = this.getContextFiles(searchResults);
      for (const file of files) {
        const fileTokens = estimateTokens(`${file.path} [${file.role}] ${file.reason}`);
        if (tokensUsed + fileTokens <= tokenBudget) {
          pack.files.push(file);
          tokensUsed += fileTokens;
        }
      }
    }

    // L2-L3: Symbol list with signatures
    if (level >= 'L2' && tokensUsed < tokenBudget) {
      const symbols = this.getContextSymbols(searchResults);
      for (const sym of symbols) {
        const symText = sym.signature
          ? `${sym.name}${sym.signature}`
          : `${sym.name} (${sym.kind})`;
        const symTokens = estimateTokens(symText);
        if (tokensUsed + symTokens <= tokenBudget) {
          pack.symbols.push(sym);
          tokensUsed += symTokens;
        }
      }
    }

    // L4: Code snippets
    if (level >= 'L4' && tokensUsed < tokenBudget) {
      const snippets = this.getCodeSnippets(searchResults);
      for (const snippet of snippets) {
        if (tokensUsed + snippet.tokenCount <= tokenBudget) {
          pack.codeSnippets.push(snippet);
          tokensUsed += snippet.tokenCount;
        }
      }
    }

    // Build call chains from graph edges
    if (tokensUsed < tokenBudget) {
      pack.callChains = this.extractCallChains(searchResults);
      tokensUsed += estimateTokens(pack.callChains.join('\n'));
    }

    if (tokensUsed < tokenBudget) {
      const evidence = buildEvidence(searchResults, pack);
      const selectedEvidence = selectEvidenceWithinBudget(evidence, tokenBudget - tokensUsed);
      if (selectedEvidence.length > 0) {
        pack.evidence = selectedEvidence;
        tokensUsed += estimateTokens(formatEvidenceItems(selectedEvidence).join('\n'));
      }
    }

    // Identify missing information
    pack.missing = this.identifyMissing(searchResults, pack);

    pack.tokensUsed = tokensUsed;
    log.info(`Packed context: level=${level}, tokens=${tokensUsed}/${tokenBudget}, files=${pack.files.length}, symbols=${pack.symbols.length}, snippets=${pack.codeSnippets.length}`);

    return pack;
  }

  /**
   * Get the project identity card.
   */
  private getProjectCard(): ProjectCard | null {
    try {
      const metaResults = this.db.exec(
        "SELECT key, value FROM index_metadata WHERE key IN ('project_name', 'total_files', 'total_symbols', 'languages', 'architecture_style', 'framework', 'root_path', 'current_commit', 'current_branch', 'index_completed', 'embedding_provider', 'vector_search')"
      );

      if (!metaResults.length || !metaResults[0].values.length) return null;

      const meta = new Map<string, string>();
      for (const row of metaResults[0].values) {
        meta.set(String(row[0]), String(row[1]));
      }

      return {
        name: meta.get('project_name') || 'Unknown',
        languages: (meta.get('languages') || '').split(',').filter(Boolean) as Language[],
        totalFiles: parseInt(meta.get('total_files') || '0', 10),
        totalSymbols: parseInt(meta.get('total_symbols') || '0', 10),
        architectureStyle: meta.get('architecture_style') || null,
        framework: meta.get('framework') || null,
        rootPath: meta.get('root_path') || '',
        currentCommit: meta.get('current_commit') || null,
        currentBranch: meta.get('current_branch') || null,
        indexCompleted: meta.get('index_completed') || null,
        vectorSearch: this.getVectorSearchStatus(
          meta.get('embedding_provider'),
          meta.get('vector_search'),
        ),
      };
    } catch {
      return null;
    }
  }

  private getVectorSearchStatus(
    embeddingProvider: string | undefined,
    vectorSearch: string | undefined,
  ): ProjectCard['vectorSearch'] {
    if (vectorSearch === 'enabled') return 'enabled';
    if (embeddingProvider && embeddingProvider !== 'none') return 'pending_index';
    return 'disabled';
  }

  /**
   * Get relevant project memories for a query.
   */
  private getRelevantMemories(query: string, searchResults: SearchResult[]): MemoryRecord[] {
    try {
      const currentCommit = this.getMetadataValue('current_commit');
      const queryTerms = tokenizeForRelevance(query);
      const resultPaths = new Set(searchResults.map((result) => result.filePath).filter(Boolean));
      const results = this.db.exec(
        `SELECT id, type, content, scope, evidence, confidence,
                created_commit, last_validated_commit, invalidation_rules,
                created_at, updated_at
         FROM memories
         WHERE type IN ('repo', 'decision', 'branch', 'user_preference')
           AND confidence > 0
         ORDER BY confidence DESC
         LIMIT 50`
      );

      if (!results.length || !results[0].values.length) return [];

      return results[0].values
        .map((row) => {
          const memory: MemoryRecord = {
            id: String(row[0]),
            type: String(row[1]) as MemoryRecord['type'],
            content: String(row[2]),
            scope: parseJsonStringArray(row[3]),
            evidence: parseJsonStringArray(row[4]),
            confidence: Number(row[5]),
            createdCommit: row[6] ? String(row[6]) : null,
            lastValidatedCommit: row[7] ? String(row[7]) : null,
            invalidationRules: parseJsonArray<MemoryRecord['invalidationRules'][number]>(row[8]),
            createdAt: String(row[9] || ''),
            updatedAt: String(row[10] || ''),
          };
          const staleReason = getMemoryStaleReason(memory, currentCommit, resultPaths);
          const relevanceScore = staleReason
            ? 0
            : scoreMemoryRelevance(memory, queryTerms, resultPaths);
          return {
            ...memory,
            stale: Boolean(staleReason),
            staleReason: staleReason || undefined,
            relevanceScore,
          };
        })
        .filter((memory) => !memory.stale && (queryTerms.length === 0 || (memory.relevanceScore || 0) > 0))
        .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  private getMetadataValue(key: string): string | null {
    try {
      const rows = this.db.exec('SELECT value FROM index_metadata WHERE key = ?', [key]);
      return rows[0]?.values[0]?.[0] ? String(rows[0].values[0][0]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Build context files from search results.
   */
  private getContextFiles(results: SearchResult[]): ContextFile[] {
    const paths = [...new Set(results.map((result) => result.filePath))];
    if (paths.length === 0) return [];

    const placeholders = paths.map(() => '?').join(',');
    const rows = this.db.exec(
      `SELECT path, role, language FROM files WHERE path IN (${placeholders})`,
      paths,
    )[0]?.values ?? [];
    const byPath = new Map(rows.map((row) => [String(row[0]), {
      role: String(row[1]) as ContextFile['role'],
      language: String(row[2]) as ContextFile['language'],
    }]));

    // Pre-build a Map from filePath to result for O(1) lookup
    const resultByPath = new Map<string, SearchResult>();
    for (const result of results) {
      if (!resultByPath.has(result.filePath)) {
        resultByPath.set(result.filePath, result);
      }
    }

    return paths.map((path) => {
      const result = resultByPath.get(path);
      const file = byPath.get(path);
      return {
        path,
        role: file?.role || 'source',
        language: file?.language || 'unknown' as ContextFile['language'],
        reason: result
          ? `Matched by ${result.sources.join('+')} (score: ${result.score.toFixed(3)})`
          : 'Matched by search result',
        confidence: result?.score || 0,
      };
    });
  }

  /**
   * Build context symbols from search results.
   */
  private getContextSymbols(results: SearchResult[]): ContextSymbol[] {
    const ids = results.filter((result) => result.kind !== 'file').map((result) => result.id);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.exec(
      `SELECT s.id, s.name, s.kind, f.path, s.start_line, s.end_line,
              s.start_column, s.end_column, s.signature, s.summary
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.id IN (${placeholders})`,
      ids,
    )[0]?.values ?? [];
    const resultById = new Map(results.map((result) => [result.id, result]));

    return rows.map((row) => {
      const result = resultById.get(String(row[0]));
      return {
        name: String(row[1]),
        kind: String(row[2]) as SymbolKind,
        filePath: String(row[3]),
        signature: row[8] ? String(row[8]) : null,
        summary: row[9] ? String(row[9]) : null,
        lineRange: [Number(row[4]), Number(row[5])],
        columnRange: [Number(row[6]), Number(row[7])],
        reason: result
          ? `Matched by ${result.sources.join('+')} (score: ${result.score.toFixed(3)})`
          : 'Matched by search result',
      };
    });
  }

  /**
   * Get code snippets for L4 context.
   */
  private getCodeSnippets(results: SearchResult[]): ContextSnippet[] {
    const snippets: ContextSnippet[] = [];
    if (results.length === 0) return snippets;

    // Collect unique file paths for batch queries
    const filePaths = [...new Set(results.map((r) => r.filePath))];

    // Resolve file paths to file IDs in one query
    const filePlaceholders = filePaths.map(() => '?').join(',');
    const fileRows = this.db.exec(
      `SELECT id, path FROM files WHERE path IN (${filePlaceholders})`,
      filePaths,
    )[0]?.values ?? [];
    const fileIdToPath = new Map<string, string>();
    const pathToFileId = new Map<string, string>();
    for (const row of fileRows) {
      const id = String(row[0]);
      const path = String(row[1]);
      fileIdToPath.set(id, path);
      pathToFileId.set(path, id);
    }

    // Collect file IDs
    const fileIds = [...pathToFileId.values()];

    // Single batch query: chunks with symbol names via JOIN
    type ChunkRow = {
      content: string;
      tokenCount: number;
      symbolId: string | null;
      symbolName: string | null;
      startLine: number;
      endLine: number;
      startColumn: number;
      endColumn: number;
      fileId: string;
    };

    let allChunks: ChunkRow[] = [];

    if (fileIds.length > 0) {
      const chunkPlaceholders = fileIds.map(() => '?').join(',');
      try {
        const chunkRows = this.db.exec(
          `SELECT c.content, c.token_count, c.symbol_id, s.name,
                  c.start_line, c.end_line, c.start_column, c.end_column, c.file_id
           FROM chunks c
           LEFT JOIN symbols s ON s.id = c.symbol_id
           WHERE c.file_id IN (${chunkPlaceholders})`,
          fileIds,
        )[0]?.values ?? [];

        allChunks = chunkRows.map((row) => ({
          content: String(row[0]),
          tokenCount: Number(row[1]),
          symbolId: row[2] ? String(row[2]) : null,
          symbolName: row[3] ? String(row[3]) : null,
          startLine: Number(row[4]),
          endLine: Number(row[5]),
          startColumn: Number(row[6]),
          endColumn: Number(row[7]),
          fileId: String(row[8]),
        }));
      } catch {
        // Skip
      }
    }

    // Group chunks by file ID for efficient lookup
    const chunksByFileId = new Map<string, ChunkRow[]>();
    for (const chunk of allChunks) {
      const list = chunksByFileId.get(chunk.fileId);
      if (list) list.push(chunk);
      else chunksByFileId.set(chunk.fileId, [chunk]);
    }

    // Group chunks by symbol ID for efficient lookup
    const chunksBySymbolId = new Map<string, ChunkRow[]>();
    for (const chunk of allChunks) {
      if (chunk.symbolId) {
        const list = chunksBySymbolId.get(chunk.symbolId);
        if (list) list.push(chunk);
        else chunksBySymbolId.set(chunk.symbolId, [chunk]);
      }
    }

    for (const r of results) {
      try {
        const fileId = pathToFileId.get(r.filePath);
        if (!fileId) continue;

        let selectedChunks: ChunkRow[];
        if (r.kind === 'file') {
          selectedChunks = (chunksByFileId.get(fileId) || []).slice(0, 5);
        } else {
          // Chunks for this symbol first, then other chunks from the same file
          const symbolChunks = chunksBySymbolId.get(r.id) || [];
          const otherChunks = (chunksByFileId.get(fileId) || [])
            .filter((c) => c.symbolId !== r.id);
          selectedChunks = [...symbolChunks, ...otherChunks].slice(0, 5);
        }

        for (const chunk of selectedChunks) {
          const lines = chunk.content.split('\n');
          const lineRange: [number, number] = [
            chunk.startLine || r.lineRange?.[0] || 1,
            chunk.endLine || r.lineRange?.[1] || lines.length,
          ];
          const columnRange: [number, number] = [
            chunk.startColumn || 0,
            chunk.endColumn || 0,
          ];

          snippets.push({
            filePath: r.filePath,
            symbolName: chunk.symbolName,
            content: chunk.content,
            lineRange,
            columnRange,
            tokenCount: chunk.tokenCount,
            reason: `Code from ${r.filePath} (score: ${r.score.toFixed(3)})`,
          });
        }
      } catch {
        // Skip
      }
    }

    // Sort by score (via search result order) and limit
    return snippets;
  }

  /**
   * Extract simple call chains from graph edges.
   */
  private extractCallChains(results: SearchResult[]): string[] {
    const chains: string[] = [];
    const symbolIds = results.filter((r) => r.kind !== 'file').map((r) => r.id);
    if (symbolIds.length === 0) return chains;

    try {
      // Batch query: get all CALLS edges for all symbol IDs at once
      const placeholders = symbolIds.map(() => '?').join(',');
      const calls = this.db.exec(
        `SELECT s1.name, e.from_id, s2.name
         FROM edges e
         JOIN symbols s1 ON e.from_id = s1.id
         JOIN symbols s2 ON e.to_id = s2.id
         WHERE e.from_id IN (${placeholders}) AND e.type = 'CALLS'`,
        symbolIds,
      );

      if (calls.length > 0) {
        // Group by from_id and limit to 5 per symbol
        const byFromId = new Map<string, string[]>();
        for (const row of calls[0].values) {
          const fromId = String(row[1]);
          const chain = `${String(row[0])} → ${String(row[2])}`;
          const list = byFromId.get(fromId);
          if (list && list.length < 5) {
            list.push(chain);
          } else if (!list) {
            byFromId.set(fromId, [chain]);
          }
        }
        // Preserve result order
        for (const id of symbolIds) {
          const idChains = byFromId.get(id);
          if (idChains) chains.push(...idChains);
        }
      }
    } catch {
      // Skip
    }

    return chains;
  }

  /**
   * Identify missing information that wasn't found.
   */
  private identifyMissing(
    results: SearchResult[],
    pack: ContextPack,
  ): string[] {
    const missing: string[] = [];

    if (results.length === 0) {
      missing.push('No search results found. Consider broadening the query or re-indexing.');
    }

    if (pack.symbols.length === 0 && results.length > 0) {
      missing.push('No symbol-level results. The code might not be fully indexed.');
    }

    if (pack.codeSnippets.length === 0 && pack.level >= 'L4') {
      missing.push('No code snippets available. Chunks may not have been generated during indexing.');
    }

    if (pack.relevantMemories.length === 0) {
      missing.push('No project memories found. Consider adding project facts with remember_project_fact.');
    }

    try {
      const unresolvedRows = this.db.exec(
        `SELECT f.path, COUNT(*)
         FROM call_refs c
         JOIN files f ON f.id = c.file_id
         WHERE c.resolution_status != 'resolved'
         GROUP BY f.path
         ORDER BY COUNT(*) DESC
         LIMIT 5`,
      )[0]?.values ?? [];
      if (unresolvedRows.length > 0) {
        missing.push('Unresolved call references remain: ' +
          unresolvedRows.map((row) => `${String(row[0])}=${Number(row[1])}`).join(', '));
      }
    } catch {
      // Older indexes may not have call_refs yet.
    }

    return missing;
  }

  /**
   * Format project card as text.
   */
  private formatProjectCard(card: ProjectCard): string {
    return [
      `Project: ${card.name}`,
      `Languages: ${card.languages.join(', ')}`,
      `Files: ${card.totalFiles} | Symbols: ${card.totalSymbols}`,
      card.currentBranch ? `Branch: ${card.currentBranch}` : '',
      card.currentCommit ? `Commit: ${card.currentCommit}` : '',
      card.indexCompleted ? `Index Completed: ${card.indexCompleted}` : '',
      `Vector Search: ${card.vectorSearch}`,
      card.architectureStyle ? `Architecture: ${card.architectureStyle}` : '',
      card.framework ? `Framework: ${card.framework}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Format the entire context pack as a text string suitable for AI consumption.
   */
  formatAsText(pack: ContextPack): string {
    const sections: string[] = [];

    // Project card
    if (pack.projectCard) {
      sections.push('=== Project ===');
      sections.push(this.formatProjectCard(pack.projectCard));
      sections.push('');
    }

    // Memories
    if (pack.relevantMemories.length > 0) {
      sections.push('=== Project Knowledge ===');
      for (const mem of pack.relevantMemories) {
        sections.push(`- ${mem.content} (confidence: ${mem.confidence})`);
      }
      sections.push('');
    }

    // Files
    if (pack.evidence && pack.evidence.length > 0) {
      sections.push('=== Evidence ===');
      sections.push(...formatEvidenceItems(pack.evidence));
      sections.push('');
    }

    // Files
    if (pack.files.length > 0) {
      sections.push('=== Relevant Files ===');
      for (const file of pack.files) {
        sections.push(`- ${file.path} [${file.role}] — ${file.reason}`);
      }
      sections.push('');
    }

    // Symbols
    if (pack.symbols.length > 0) {
      sections.push('=== Symbols ===');
      for (const sym of pack.symbols) {
        const sig = sym.signature ? `: ${sym.signature}` : '';
        const sum = sym.summary ? ` — ${sym.summary}` : '';
        sections.push(
          `- ${sym.name} (${sym.kind}) at ${formatLocation(sym.filePath, sym.lineRange, sym.columnRange)}${sig}${sum}`,
        );
      }
      sections.push('');
    }

    // Code snippets
    if (pack.codeSnippets.length > 0) {
      sections.push('=== Code ===');
      for (const snippet of pack.codeSnippets) {
        const header = snippet.symbolName
          ? `// ${snippet.symbolName} (${formatLocation(snippet.filePath, snippet.lineRange, snippet.columnRange)})`
          : `// ${formatLocation(snippet.filePath, snippet.lineRange, snippet.columnRange)}`;
        sections.push(header);
        sections.push(snippet.content);
        sections.push('');
      }
    }

    // Call chains
    if (pack.callChains.length > 0) {
      sections.push('=== Call Chains ===');
      for (const chain of pack.callChains) {
        sections.push(`  ${chain}`);
      }
      sections.push('');
    }

    // Missing info
    if (pack.missing.length > 0) {
      sections.push('=== Missing Info ===');
      for (const m of pack.missing) {
        sections.push(`⚠ ${m}`);
      }
    }

    // Metadata
    sections.push('');
    sections.push(`[Context: level=${pack.level}, tokens=${pack.tokensUsed}/${pack.tokenBudget}]`);

    return sections.join('\n');
  }

}

function formatLocation(
  filePath: string,
  lineRange: [number, number],
  columnRange: [number, number],
): string {
  return `${filePath}:${lineRange[0]}:${columnRange[0]}-${lineRange[1]}:${columnRange[1]}`;
}

function parseJsonArray<T = unknown>(value: unknown): T[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonStringArray(value: unknown): string[] {
  return parseJsonArray(value).map(String);
}

function tokenizeForRelevance(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^a-z0-9]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3),
  )];
}

function scoreMemoryRelevance(
  memory: MemoryRecord,
  queryTerms: string[],
  resultPaths: Set<string>,
): number {
  const searchable = [
    memory.content,
    ...memory.scope,
    ...memory.evidence,
  ].join(' ').toLowerCase();
  const matchedTerms = queryTerms.filter((term) => searchable.includes(term)).length;
  const termScore = queryTerms.length === 0 ? 0.2 : matchedTerms / queryTerms.length;
  const scopeScore = [...resultPaths].some((path) =>
    memory.scope.includes(path) || memory.evidence.some((item) => item.includes(path))
  ) ? 1 : 0;

  if (queryTerms.length > 0 && matchedTerms === 0 && scopeScore === 0) {
    return 0;
  }

  return (memory.confidence * 0.6) + (termScore * 0.25) + (scopeScore * 0.15);
}

function getMemoryStaleReason(
  memory: MemoryRecord,
  currentCommit: string | null,
  resultPaths: Set<string>,
): string | null {
  if (memory.confidence <= 0.2) return 'confidence_too_low';

  if (
    currentCommit &&
    memory.lastValidatedCommit &&
    memory.lastValidatedCommit !== currentCommit &&
    memory.invalidationRules.some((rule) => rule.type === 'commit')
  ) {
    return 'commit_changed';
  }

  for (const rule of memory.invalidationRules) {
    if (rule.type !== 'file_change') continue;
    if (!currentCommit || !memory.lastValidatedCommit || memory.lastValidatedCommit === currentCommit) {
      continue;
    }
    for (const path of resultPaths) {
      if (rule.target === '*' || path === rule.target || path.includes(rule.target)) {
        return 'evidence_file_changed';
      }
    }
  }

  return null;
}
