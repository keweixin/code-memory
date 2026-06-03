/**
 * MCP Tool: search_code
 *
 * Hybrid search across files and symbols using keyword (FTS5),
 * optional vector search, and graph expansion.
 * Returns ranked results with snippets and metadata.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { HybridSearchEngine } from "../../search/hybrid-search.js";
import type { VectorSearchProvider } from "../../search/vector-search.js";
import { createLogger } from "../../shared/logger.js";
import { prependIndexDiagnostics } from "../index-diagnostics.js";
import { withRepoDatabase } from "../repo-router.js";
import { TOOL_CONTEXT_INPUT_SCHEMA } from "../tool-context.js";
import {
  attachStaleBanner,
  partitionPending,
} from "./_stale-banner.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";

import {
  loadVectorSearchProviderForRepo,
  type VectorSearchProviderResolver,
} from "../vector-provider-router.js";

const log = createLogger("mcp:search-code");
const SEARCH_INTENTS = ["debug", "refactor", "add_test", "explain", "route", "security", "general"] as const;

export function registerSearchCodeTool(
  server: McpServer,
  db?: SqlJsDatabase,
  vectorSearchProvider?: VectorSearchProvider | null,
  vectorSearchProviderResolver: VectorSearchProviderResolver = loadVectorSearchProviderForRepo,
): void {
  const searchEngine = db ? new HybridSearchEngine(db, undefined, vectorSearchProvider || undefined) : null;

  server.tool(
    "search_code",
    "Search across all indexed code (files and symbols). Hybrid mode " +
    "combines keyword, vector (when embeddings are enabled), and graph-based expansion. " +
    "Returns ranked results with snippets and location information. " +
    "Use this when you need to find relevant code for a task or question.",
    {
      query: z.string().describe("Natural language query or code snippet to search for"),
      limit: z.number().describe("Maximum number of results (default 15, max 50)").optional().default(15),
      fileFilter: z.string().describe("Optional glob pattern to filter results by file path").optional(),
      searchMode: z.enum(["hybrid", "keyword", "vector", "graph"]).describe("Search mode: hybrid (default), keyword-only, vector-only, or graph-only").optional().default("hybrid"),
      intent: z.enum(SEARCH_INTENTS).describe("Optional task intent used to select graph expansion edges").optional(),
      sessionId: z.string().optional().describe("Optional session/task ID used to lower-rank context already returned in this session"),
      avoidRepeated: z.boolean().optional().default(false).describe("When sessionId is set, lower-rank repeated files, symbols, and chunks before returning results"),
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ query, limit, fileFilter, searchMode, intent, sessionId, avoidRepeated, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, db, async (activeDb, projectRoot) => {
          const activeVectorSearchProvider = activeDb !== db
            ? await vectorSearchProviderResolver(projectRoot)
            : vectorSearchProvider || null;
          const activeSearchEngine = searchEngine && activeDb === db
            ? searchEngine
            : new HybridSearchEngine(activeDb, undefined, activeVectorSearchProvider || undefined);
          const results = await activeSearchEngine.searchCode(query, {
            limit: Math.min(limit, 50),
            fileFilter: fileFilter || undefined,
            searchMode,
            intent,
            sessionId,
            avoidRepeated,
          });

          if (results.length === 0) {
            const modeHint = searchMode === 'graph'
              ? "\n\nGraph mode only expands from indexed symbols that match the query. Try 'hybrid' or 'keyword' mode first if there is no obvious seed symbol."
              : searchMode === 'vector'
                ? "\n\nVector mode only searches indexed chunk embeddings. Configure embeddings, run 'code-memory bootstrap --project .', and use 'hybrid' or 'keyword' mode if no vectors are present."
                : "";
            return {
              content: [{
                type: "text" as const,
                text: wrapWithStaleBanner(prependIndexDiagnostics(
                  `No results found for "${query}".\n\nTry broadening your query, or ensure the codebase has been indexed with 'code-memory index'.${modeHint}`,
                  activeDb,
                  projectRoot,
                ), activeDb),
              }],
            };
          }

          const baseText = prependIndexDiagnostics(formatSearchResults(query, results), activeDb, projectRoot);
          const text = wrapWithStaleBanner(baseText, activeDb);
          log.info(`Search "${query}" returned ${results.length} results`);

          return {
            content: [{ type: "text" as const, text }],
          };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory setup --project .\` for full AI onboarding, or \`code-memory bootstrap --project .\` for index-only initialization.`,
            }],
            isError: false,
          };
        }

        log.error(`Search failed: ${errorMsg}`);
        const text = `Error: Search failed - ${errorMsg}`;
        return {
          content: [{
            type: "text" as const,
            text: wrapWithStaleBanner(db ? prependIndexDiagnostics(text, db) : text, db),
          }],
          isError: true,
        };
      }
    },
  );
}

// ── Formatting ───────────────────────────────────────────────

function wrapWithStaleBanner(text: string, activeDb?: SqlJsDatabase): string {
  if (!activeDb) return text;
  const pending = getActiveWatchState()?.getPendingFiles() ?? [];
  let staleMemoriesCount = 0;
  try {
    const rows = activeDb.exec("SELECT COUNT(*) FROM memories WHERE confidence < 0.6");
    if (rows.length > 0 && rows[0].values.length > 0) {
      staleMemoriesCount = Number(rows[0].values[0][0]);
    }
  } catch (_e) { /* safe to ignore */ }
  if (pending.length === 0 && staleMemoriesCount === 0) return text;
  const { inResponse, notInResponse } = partitionPending(pending, text);
  return attachStaleBanner(text, inResponse, notInResponse, Date.now(), staleMemoriesCount);
}

function formatSearchResults(
  query: string,
  results: Array<{
    id: string;
    name: string;
    kind: string;
    filePath: string;
    score: number;
    sources: string[];
    snippet: string | null;
    lineRange: [number, number] | null;
    columnRange: [number, number] | null;
    scoreBreakdown?: {
      keywordRank?: number;
      vectorRank?: number;
      graphRank?: number;
      rrfKeyword?: number;
      rrfVector?: number;
      rrfGraph?: number;
      keyword?: number;
      vector?: number;
      graph?: number;
      ledgerPenalty?: number;
      finalScore?: number;
    };
    diagnostics?: {
      intent?: string;
      vectorUsed: boolean;
      graphUsed: boolean;
      repeatedContextPenalized?: number;
      totalPriorContextTokens?: number;
      graphProfile?: {
        direction: string;
        edgeTypes: string[];
      };
    };
  }>,
): string {
  const lines: string[] = [];
  lines.push(`Search results for: "${query}"`);
  lines.push(`Found ${results.length} results`);
  const diagnostics = results.find((result) => result.diagnostics)?.diagnostics;
  if (diagnostics) {
    lines.push(`Intent: ${diagnostics.intent || 'general'}`);
    lines.push(`Retrieval: vector=${diagnostics.vectorUsed ? 'used' : 'skipped'}, graph=${diagnostics.graphUsed ? 'used' : 'skipped'}`);
    if (diagnostics.graphProfile) {
      lines.push(
        `Graph profile: direction=${diagnostics.graphProfile.direction}, edges=${diagnostics.graphProfile.edgeTypes.join(',')}`,
      );
    }
    if (diagnostics.repeatedContextPenalized) {
      lines.push(
        `Ledger: penalized=${diagnostics.repeatedContextPenalized}, priorTokens=${diagnostics.totalPriorContextTokens || 0}`,
      );
    }
  }
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rank = `${i + 1}.`.padEnd(3);
    const score = `[${r.score.toFixed(2)}]`.padEnd(8);
    const kind = r.kind;
    const sources = r.sources.join("+");

    lines.push(`${rank} ${score} ${r.name} (${kind})`);
    if (r.lineRange) {
      lines.push(`     Location: ${formatLocation(r.filePath, r.lineRange, r.columnRange)}`);
    } else {
      lines.push(`     Location: ${r.filePath}`);
    }
    if (r.snippet) {
      const cleanSnippet = r.snippet.replace(/<</g, "**").replace(/>>/g, "**");
      lines.push(`     Snippet: ${cleanSnippet}`);
    }
    lines.push(`     Sources: ${sources}`);
    if (r.scoreBreakdown) {
      lines.push(`     Score breakdown: ${formatScoreBreakdown(r.scoreBreakdown)}`);
    }
    if (r.scoreBreakdown?.ledgerPenalty) {
      lines.push(`     Ledger penalty: ${r.scoreBreakdown.ledgerPenalty.toFixed(2)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatLocation(
  filePath: string,
  lineRange: [number, number],
  columnRange: [number, number] | null,
): string {
  if (!columnRange) return `${filePath}:${lineRange[0]}-${lineRange[1]}`;
  return `${filePath}:${lineRange[0]}:${columnRange[0]}-${lineRange[1]}:${columnRange[1]}`;
}

function formatScoreBreakdown(scoreBreakdown: {
  keywordRank?: number;
  vectorRank?: number;
  graphRank?: number;
  rrfKeyword?: number;
  rrfVector?: number;
  rrfGraph?: number;
  keyword?: number;
  vector?: number;
  graph?: number;
  ledgerPenalty?: number;
  finalScore?: number;
}): string {
  const parts = [
    scoreBreakdown.keywordRank !== undefined ? `keywordRank=${scoreBreakdown.keywordRank}` : '',
    scoreBreakdown.vectorRank !== undefined ? `vectorRank=${scoreBreakdown.vectorRank}` : '',
    scoreBreakdown.graphRank !== undefined ? `graphRank=${scoreBreakdown.graphRank}` : '',
    scoreBreakdown.rrfKeyword !== undefined ? `rrfKeyword=${scoreBreakdown.rrfKeyword.toFixed(3)}` : '',
    scoreBreakdown.rrfVector !== undefined ? `rrfVector=${scoreBreakdown.rrfVector.toFixed(3)}` : '',
    scoreBreakdown.rrfGraph !== undefined ? `rrfGraph=${scoreBreakdown.rrfGraph.toFixed(3)}` : '',
    scoreBreakdown.keyword !== undefined ? `keyword=${scoreBreakdown.keyword.toFixed(3)}` : '',
    scoreBreakdown.vector !== undefined ? `vector=${scoreBreakdown.vector.toFixed(3)}` : '',
    scoreBreakdown.graph !== undefined ? `graph=${scoreBreakdown.graph.toFixed(3)}` : '',
    scoreBreakdown.ledgerPenalty !== undefined ? `ledgerPenalty=${scoreBreakdown.ledgerPenalty.toFixed(3)}` : '',
    scoreBreakdown.finalScore !== undefined ? `finalScore=${scoreBreakdown.finalScore.toFixed(3)}` : '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : 'none';
}
