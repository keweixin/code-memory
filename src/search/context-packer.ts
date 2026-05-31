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

import type { Database as SqlJsDatabase } from 'sql.js';
import type {
  ContextPack,
  ContextLevel,
  ContextFile,
  ContextSymbol,
  ContextSnippet,
  ProjectCard,
  MemoryRecord,
  SearchResult,
  CodeMemoryConfig,
  TokenBudgets,
  SymbolKind,
} from '../shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../shared/types.js';
import { estimateTokens, truncateToTokenBudget } from '../shared/token-counter.js';
import { createLogger } from '../shared/logger.js';

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
    };

    // Determine the maximum context level we can afford
    const level = this.resolveLevel(tokenBudget, maxLevel);
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
      const memories = this.getRelevantMemories(query);
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

    // Identify missing information
    pack.missing = this.identifyMissing(searchResults, pack);

    pack.tokensUsed = tokensUsed;
    log.info(`Packed context: level=${level}, tokens=${tokensUsed}/${tokenBudget}, files=${pack.files.length}, symbols=${pack.symbols.length}, snippets=${pack.codeSnippets.length}`);

    return pack;
  }

  /**
   * Determine the context level based on token budget.
   */
  private determineLevel(budget: number): ContextLevel {
    if (budget <= this.budgets.L0) return 'L0';
    if (budget <= this.budgets.L1) return 'L1';
    if (budget <= this.budgets.L2) return 'L2';
    if (budget <= this.budgets.L3) return 'L3';
    if (budget <= this.budgets.L4) return 'L4';
    return 'L5';
  }

  private resolveLevel(budget: number, requestedMaxLevel?: ContextLevel): ContextLevel {
    const budgetLevel = this.determineLevel(budget);
    if (!requestedMaxLevel) return budgetLevel;

    return compareContextLevels(requestedMaxLevel, budgetLevel) < 0
      ? requestedMaxLevel
      : budgetLevel;
  }

  /**
   * Get the project identity card.
   */
  private getProjectCard(): ProjectCard | null {
    try {
      const metaResults = this.db.exec(
        "SELECT key, value FROM index_metadata WHERE key IN ('project_name', 'total_files', 'total_symbols', 'languages', 'architecture_style', 'framework', 'root_path')"
      );

      if (!metaResults.length || !metaResults[0].values.length) return null;

      const meta = new Map<string, string>();
      for (const row of metaResults[0].values) {
        meta.set(String(row[0]), String(row[1]));
      }

      return {
        name: meta.get('project_name') || 'Unknown',
        languages: (meta.get('languages') || '').split(',').filter(Boolean) as any,
        totalFiles: parseInt(meta.get('total_files') || '0', 10),
        totalSymbols: parseInt(meta.get('total_symbols') || '0', 10),
        architectureStyle: meta.get('architecture_style') || null,
        framework: meta.get('framework') || null,
        rootPath: meta.get('root_path') || '',
      };
    } catch {
      return null;
    }
  }

  /**
   * Get relevant project memories for a query.
   */
  private getRelevantMemories(query: string): MemoryRecord[] {
    try {
      // Get all memories and filter by scope relevance
      const results = this.db.exec(
        "SELECT id, type, content, scope, evidence, confidence FROM memories WHERE type IN ('repo', 'decision') ORDER BY confidence DESC LIMIT 10"
      );

      if (!results.length || !results[0].values.length) return [];

      return results[0].values.map((row) => ({
        id: String(row[0]),
        type: String(row[1]) as MemoryRecord['type'],
        content: String(row[2]),
        scope: JSON.parse(String(row[3]) || '[]'),
        evidence: JSON.parse(String(row[4]) || '[]'),
        confidence: Number(row[5]),
        createdCommit: null,
        lastValidatedCommit: null,
        invalidationRules: [],
        createdAt: '',
        updatedAt: '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Build context files from search results.
   */
  private getContextFiles(results: SearchResult[]): ContextFile[] {
    const seen = new Set<string>();
    const files: ContextFile[] = [];

    for (const r of results) {
      if (seen.has(r.filePath)) continue;
      seen.add(r.filePath);

      // Get file role
      let role = 'source';
      try {
        const fileResult = this.db.exec(
          'SELECT role, language FROM files WHERE path = ?',
          [r.filePath],
        );
        if (fileResult.length > 0 && fileResult[0].values.length > 0) {
          role = String(fileResult[0].values[0][0]);
        }
      } catch {
        // Use default
      }

      files.push({
        path: r.filePath,
        role: role as ContextFile['role'],
        language: 'unknown' as any,
        reason: `Matched by ${r.sources.join('+')} (score: ${r.score.toFixed(3)})`,
        confidence: r.score,
      });
    }

    return files;
  }

  /**
   * Build context symbols from search results.
   */
  private getContextSymbols(results: SearchResult[]): ContextSymbol[] {
    const symbols: ContextSymbol[] = [];

    for (const r of results) {
      if (r.kind === 'file') continue;

      try {
        const symResult = this.db.exec(
          `SELECT name, kind, file_id, start_line, end_line, start_column,
                  end_column, signature, summary
           FROM symbols WHERE id = ?`,
          [r.id],
        );

        if (symResult.length > 0 && symResult[0].values.length > 0) {
          const row = symResult[0].values[0];

          // Get file path
          let filePath = r.filePath;
          try {
            const filePathResult = this.db.exec(
              'SELECT path FROM files WHERE id = ?',
              [String(row[2])],
            );
            if (filePathResult.length > 0 && filePathResult[0].values.length > 0) {
              filePath = String(filePathResult[0].values[0][0]);
            }
          } catch {
            // Use search result filePath
          }

          symbols.push({
            name: String(row[0]),
            kind: String(row[1]) as SymbolKind,
            filePath,
            signature: row[7] ? String(row[7]) : null,
            summary: row[8] ? String(row[8]) : null,
            lineRange: [Number(row[3]), Number(row[4])],
            columnRange: [Number(row[5]), Number(row[6])],
            reason: `Matched by ${r.sources.join('+')}`,
          });
        }
      } catch {
        // Skip
      }
    }

    return symbols;
  }

  /**
   * Get code snippets for L4 context.
   */
  private getCodeSnippets(results: SearchResult[]): ContextSnippet[] {
    const snippets: ContextSnippet[] = [];

    for (const r of results) {
      try {
        const chunkResult = r.kind === 'file'
          ? this.db.exec(
              `SELECT content, token_count, symbol_id, start_line, end_line,
                      start_column, end_column
               FROM chunks WHERE file_id = (SELECT id FROM files WHERE path = ?) LIMIT 5`,
              [r.filePath],
            )
          : this.db.exec(
              `SELECT content, token_count, symbol_id, start_line, end_line,
                      start_column, end_column
               FROM chunks WHERE symbol_id = ?
               UNION ALL
               SELECT content, token_count, symbol_id, start_line, end_line,
                      start_column, end_column
               FROM chunks
               WHERE file_id = (SELECT id FROM files WHERE path = ?) AND symbol_id != ?
               LIMIT 5`,
              [r.id, r.filePath, r.id],
            );

        if (chunkResult.length > 0) {
          for (const row of chunkResult[0].values) {
            const content = String(row[0]);
            const tokenCount = Number(row[1]);
            const symbolId = row[2] ? String(row[2]) : null;

            // Get symbol name for the chunk
            let symbolName = null;
            if (symbolId) {
              try {
                const symName = this.db.exec(
                  'SELECT name FROM symbols WHERE id = ?',
                  [symbolId],
                );
                if (symName.length > 0 && symName[0].values.length > 0) {
                  symbolName = String(symName[0].values[0][0]);
                }
              } catch {
                // Skip
              }
            }

            // Prefer persisted chunk coordinates; fall back to search result lines.
            const lines = content.split('\n');
            const lineRange: [number, number] = [
              Number(row[3]) || r.lineRange?.[0] || 1,
              Number(row[4]) || r.lineRange?.[1] || lines.length,
            ];
            const columnRange: [number, number] = [
              Number(row[5]) || 0,
              Number(row[6]) || 0,
            ];

            snippets.push({
              filePath: r.filePath,
              symbolName,
              content,
              lineRange,
              columnRange,
              tokenCount,
              reason: `Code from ${r.filePath} (score: ${r.score.toFixed(3)})`,
            });
          }
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

    for (const r of results) {
      if (r.kind === 'file') continue;

      try {
        // Get outgoing CALLS edges
        const calls = this.db.exec(
          "SELECT s1.name, e.type, s2.name FROM edges e JOIN symbols s1 ON e.from_id = s1.id JOIN symbols s2 ON e.to_id = s2.id WHERE e.from_id = ? AND e.type = 'CALLS' LIMIT 5",
          [r.id],
        );

        if (calls.length > 0) {
          for (const row of calls[0].values) {
            chains.push(`${String(row[0])} → ${String(row[2])}`);
          }
        }
      } catch {
        // Skip
      }
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

function compareContextLevels(a: ContextLevel, b: ContextLevel): number {
  return contextLevelRank(a) - contextLevelRank(b);
}

function contextLevelRank(level: ContextLevel): number {
  switch (level) {
    case 'L0': return 0;
    case 'L1': return 1;
    case 'L2': return 2;
    case 'L3': return 3;
    case 'L4': return 4;
    case 'L5': return 5;
  }
}
