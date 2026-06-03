/**
 * MCP Tool: get_context_pack
 *
 * Searches the codebase and packs relevant context for AI consumption.
 * Uses HybridSearchEngine to find relevant code and ContextPacker
 * to organize it into a token-budgeted context pack.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import type { SqlJsDatabase } from "../../storage/database.js";
import { HybridSearchEngine } from "../../search/hybrid-search.js";
import type { VectorSearchProvider } from "../../search/vector-search.js";
import { ContextPacker } from "../../search/context-packer.js";
import {
  countIndexedNodes,
  estimatePackTokens,
  filterLowValueFiles,
  getAdaptiveBudget,
} from "../../search/context-budget.js";
import { collectPackContext, omitRepeatedContext } from "../../search/context-ledger-filter.js";
import { getContextDeltaForDb, markContextUsed } from "../../memory/context-ledger.js";
import type { ContextDelta, ContextPack } from "../../shared/types.js";
import { CONFIG_DIR, DATABASE_FILE } from "../../shared/constants.js";
import { estimateTokens } from "../../shared/token-counter.js";
import { createLogger } from "../../shared/logger.js";
import { prependIndexDiagnostics } from "../index-diagnostics.js";
import { withRepoDatabase } from "../repo-router.js";
import {
  attachStaleBanner,
  partitionPending,
} from "./_stale-banner.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";
import { getIndexStaleness } from "../../indexer/staleness.js";
import {
  loadVectorSearchProviderForRepo,
  type VectorSearchProviderResolver,
} from "../vector-provider-router.js";

const log = createLogger("mcp:get-context-pack");

export function registerGetContextPackTool(
  server: McpServer,
  db: SqlJsDatabase,
  vectorSearchProvider?: VectorSearchProvider | null,
  vectorSearchProviderResolver: VectorSearchProviderResolver = loadVectorSearchProviderForRepo,
): void {
  const searchEngine = db ? new HybridSearchEngine(db, undefined, vectorSearchProvider || undefined) : null;
  const packer = db ? new ContextPacker(db) : null;

  server.tool(
    "get_context_pack",
    "Search the codebase and pack relevant context for AI consumption. " +
    "Combines search results, project card, memories, file lists, " +
    "symbols, code snippets, and call chains into a token-budgeted " +
    "context pack. Use this to prepare context before coding.",
    {
      query: z.string().describe("What you want to find context for (natural language or code query)"),
      tokenBudget: z.number().describe("Maximum tokens for the packed context (default 4000, max 12000)").optional().default(4000),
      levels: z.enum(["L0", "L1", "L2", "L3", "L4"]).describe("Maximum context detail level to return (L0=card, L4=full snippets)").optional(),
      sessionId: z.string().optional().describe("Optional session/task ID used to track returned context and avoid repeats"),
      avoidRepeated: z.boolean().optional().default(false).describe("When sessionId is set, omit files, symbols, and snippets already returned in this session"),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ query, tokenBudget, levels, sessionId, avoidRepeated, repo }) => {
      try {
        return await withRepoDatabase(repo, db, async (activeDb, projectRoot) => {
          const activeVectorSearchProvider = repo || activeDb !== db
            ? await vectorSearchProviderResolver(projectRoot)
            : vectorSearchProvider || null;
          const activeSearchEngine = searchEngine && activeDb === db
            ? searchEngine
            : new HybridSearchEngine(activeDb, undefined, activeVectorSearchProvider || undefined);
          const activePacker = packer && activeDb === db
            ? packer
            : new ContextPacker(activeDb);
          const budget = Math.min(tokenBudget, 12000);

          // Phase 1: Search
          log.info("Searching for: " + query);
          const searchLimit = sessionId && avoidRepeated ? 60 : 20;
          const results = await activeSearchEngine.searchCode(query, {
            limit: searchLimit,
            sessionId,
            avoidRepeated,
          });

          // Phase 2: Pack
          const pack = await activePacker.pack(query, results, {
            tokenBudget: budget,
            includeProjectCard: true,
            includeMemories: true,
            maxLevel: levels,
          });

          // Phase 2.5: Apply adaptive output budget
          const adaptiveBudget = getAdaptiveBudget(countIndexedNodes(activeDb));
          if (adaptiveBudget.excludeLowValueFiles) {
            pack.files = filterLowValueFiles(pack.files);
          }
          if (pack.files.length > adaptiveBudget.maxFiles) {
            pack.files = pack.files.slice(0, adaptiveBudget.maxFiles);
          }

          let ledgerText = "";
          if (sessionId) {
            const candidates = collectPackContext(pack);
            const delta = getContextDeltaForDb(sessionId, candidates, activeDb);
            const omitted = avoidRepeated ? omitRepeatedContext(pack, delta, sessionId) : false;
            const finalContext = collectPackContext(pack);
            if (omitted) {
              pack.tokensUsed = estimatePackTokens(pack);
              pack.missing.push(
                "Fill-after-omit used " + searchLimit +
                " ranked candidates before removing repeated context.",
              );
            }
            const baseText = activePacker.formatAsText(pack);
            const entryId = markContextUsed({
              sessionId,
              query,
              repoRoot: projectRoot,
              returnedFiles: finalContext.files,
              returnedSymbols: finalContext.symbols,
              returnedChunks: finalContext.chunks,
              tokenEstimate: estimateTokens(baseText),
              evidenceIds: finalContext.evidenceIds,
            }, activeDb);
            ledgerText = formatLedgerSection(sessionId, delta, entryId, omitted);
          }

          // Phase 3: Format
          const baseText = prependIndexDiagnostics(
            [ledgerText, formatToolTrustContract(pack, projectRoot, activeDb), activePacker.formatAsText(pack)].filter(Boolean).join("\n\n"),
            activeDb,
            projectRoot,
          );
          const text = wrapWithStaleBanner(baseText, activeDb);
          log.info("Context pack: level=" + pack.level + ", tokens=" + pack.tokensUsed + "/" + budget);

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

        log.error("Get context pack failed: " + errorMsg);
        return {
          content: [{ type: "text" as const, text: wrapWithStaleBanner(prependIndexDiagnostics("Error: Get context pack failed - " + errorMsg, db), db) }],
          isError: true,
        };
      }
    },
  );
}

function formatToolTrustContract(pack: ContextPack, projectRoot: string, db: SqlJsDatabase): string {
  const freshness = getIndexStaleness(projectRoot, db);
  const exactSnippets = pack.codeSnippets.slice(0, 5).map((snippet) => ({
    file: snippet.filePath,
    lines: snippet.lineRange[0] + "-" + snippet.lineRange[1],
    symbol: snippet.symbolName,
    why: snippet.reason,
  }));
  const whyIncluded = pack.files.slice(0, 8).map((file) => ({
    file: file.path,
    reason: file.reason,
    confidence: Number(file.confidence.toFixed(2)),
  }));
  const nextAllowedReads = pack.codeSnippets.length > 0
    ? unique(pack.codeSnippets.map((snippet) => snippet.filePath)).slice(0, 5)
    : pack.files.slice(0, 5).map((file) => file.path);
  const confidence = freshness.indexStatus === "fresh" && (pack.codeSnippets.length > 0 || pack.files.length > 0)
    ? "ready"
    : freshness.indexStatus === "stale" || freshness.indexStatus === "failed"
      ? "stale"
      : "low";

  return [
    "=== Tool Trust Contract ===",
    JSON.stringify({
      confidence,
      projectRoot,
      dbPath: join(projectRoot, CONFIG_DIR, DATABASE_FILE),
      indexStatus: freshness.indexStatus,
      exactSnippets,
      whyIncluded,
      nextAllowedReads,
      freshness: {
        changedFiles: freshness.changedFiles,
        watchPendingCount: freshness.watchPendingCount,
        recommendedAction: freshness.recommendedAction,
      },
    }, null, 2),
  ].join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatLedgerSection(
  sessionId: string,
  delta: ContextDelta,
  entryId: string,
  omitted: boolean,
): string {
  const lines = [
    "=== Context Ledger ===",
    "Session: " + sessionId,
    "Prior tokens: " + delta.totalPriorTokens,
    "New files: " + delta.newFiles.length,
    "Repeated files: " + delta.repeatedFiles.length,
    "New symbols: " + delta.newSymbols.length,
    "Repeated symbols: " + delta.repeatedSymbols.length,
    "New chunks: " + delta.newChunks.length,
    "Repeated chunks: " + delta.repeatedChunks.length,
    "Ledger entry: " + entryId,
  ];

  if (omitted) {
    lines.push("Repeated context omitted for session " + sessionId + ".");
  }

  return lines.join("\n");
}

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
