/**
 * MCP Tool: plan_context
 *
 * Produces a retrieval plan before fetching or packing code context.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { SCHEMA_VERSION } from "../../storage/schema.js";
import { classifySearchIntent, getIntentGraphProfile } from "../../search/intent-router.js";
import { getContextLedgerEntriesForDb } from "../../memory/context-ledger.js";
import {
  applyOutputCharBudget,
  countIndexedNodes,
  getAdaptiveBudget,
} from "../../search/context-budget.js";
import type { SearchIntent } from "../../shared/types.js";
import { createLogger } from "../../shared/logger.js";
import { prependIndexDiagnostics } from "../index-diagnostics.js";
import { withRepoDatabase } from "../repo-router.js";
import {
  attachStaleBanner,
  partitionPending,
} from "./_stale-banner.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";

const log = createLogger("mcp:plan-context");
const SEARCH_INTENTS = ["debug", "refactor", "add_test", "explain", "route", "security", "general"] as const;
const SEARCH_MODES = ["hybrid", "keyword", "vector", "graph"] as const;
const CONTEXT_LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;

export function registerPlanContextTool(server: McpServer, db: SqlJsDatabase): void {
  server.tool(
    "plan_context",
    "Plan codebase context retrieval before fetching snippets. " +
    "Classifies task intent, selects retrieval routes, shows graph edge profile, " +
    "checks vector/index/ledger readiness, and recommends the next context tool call.",
    {
      query: z.string().describe("Task or question to plan context for"),
      tokenBudget: z.number().optional().default(4000).describe("Target context budget"),
      intent: z.enum(SEARCH_INTENTS).optional().describe("Optional explicit task intent"),
      searchMode: z.enum(SEARCH_MODES).optional().describe("Optional search mode override"),
      levels: z.enum(CONTEXT_LEVELS).optional().describe("Optional maximum context level"),
      sessionId: z.string().optional().describe("Optional session/task ID for ledger delta planning"),
      avoidRepeated: z.boolean().optional().default(true).describe("Whether later retrieval should prefer context deltas"),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ query, tokenBudget, intent, searchMode, levels, sessionId, avoidRepeated, repo }) => {
      try {
        return await withRepoDatabase(repo, db, async (activeDb, projectRoot) => {
          const classification = classifySearchIntent(query, intent as SearchIntent | undefined);
          const graphProfile = getIntentGraphProfile(classification.intent);
          const metadata = getIndexMetadata(activeDb);
          const vectorStatus = getVectorStatus(metadata);
          const recommendedMode = searchMode || (vectorStatus === "enabled" ? "hybrid" : "hybrid");
          const ledgerEntries = sessionId ? getContextLedgerEntriesForDb(sessionId, activeDb) : [];
          const priorTokens = ledgerEntries.reduce((sum, entry) => sum + entry.tokenEstimate, 0);
          const suggestedLevel = levels || suggestContextLevel(tokenBudget);
          const adaptiveBudget = getAdaptiveBudget(countIndexedNodes(activeDb));

          const lines = [
            "Context retrieval plan",
            "Query: " + query,
            "Schema: v" + SCHEMA_VERSION,
            "Intent: " + classification.intent + " (" + classification.source + ")",
            "Intent hints: " + formatList(classification.matchedHints),
            "Search mode: " + recommendedMode,
            "Token budget: " + tokenBudget,
            "Max level: " + suggestedLevel,
            "Adaptive budget: tier=" + adaptiveBudget.tier +
              " (maxOutputChars=" + adaptiveBudget.maxOutputChars +
              ", maxFiles=" + adaptiveBudget.maxFiles +
              ", excludeLowValueFiles=" + adaptiveBudget.excludeLowValueFiles + ")",
            "Vector search: " + vectorStatus,
            "Index commit: " + (metadata.get("current_commit") || "(unknown)"),
            "Index completed: " + (metadata.get("index_completed") || "(unknown)"),
            "Ledger session: " + (sessionId || "(none)"),
            "Ledger prior entries: " + ledgerEntries.length,
            "Ledger prior tokens: " + priorTokens,
            "Avoid repeated context: " + (sessionId && avoidRepeated ? "yes" : "no"),
            "",
            "Retrieval routes:",
            "- keyword: FTS5 BM25 over files and symbols",
            "- graph: " + (graphProfile
              ? `${graphProfile.direction} over ${graphProfile.edgeTypes.join(",")}`
              : "disabled until a seed/profile is available"),
            "- vector: " + (vectorStatus === "enabled" ? "enabled" : "skipped unless embeddings are indexed"),
            "- memory: query/scope/evidence relevance, stale commit memories filtered",
            "- ledger: " + (sessionId && avoidRepeated
              ? "pre-pack rerank penalty plus post-pack repeated evidence removal"
              : "not active without sessionId + avoidRepeated"),
            "",
            "Recommended next call:",
            `get_context_pack({ query: ${JSON.stringify(query)}, tokenBudget: ${tokenBudget}, levels: ${JSON.stringify(suggestedLevel)}, sessionId: ${JSON.stringify(sessionId || "")}, avoidRepeated: ${Boolean(sessionId && avoidRepeated)}, repo: ${JSON.stringify(repo || "")} })`,
          ];

          log.info("Planned context retrieval for: " + query);
          const planText = applyOutputCharBudget(lines.join("\n"), adaptiveBudget.maxOutputChars);
          const baseText = prependIndexDiagnostics(planText, activeDb, projectRoot);
          return { content: [{ type: "text" as const, text: wrapWithStaleBanner(baseText) }] };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Detect uninitialized repository errors from resolveRepoRoot
        // Pattern matches both "is not registered" and "does not contain" substrings
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          log.warn(`[Auto-Bootstrap] Trapped raw repo entry event for path "${repo || 'current'}". Injecting self-awakening guide.`);
          const repoArg = typeof repo === 'string' ? repo : process.cwd();
          return {
            content: [{
              type: "text" as const,
              text: [
                `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===`,
                `Target Repository Workspace: "${repoArg}"`,
                `Status: RAW / UNINITIALIZED (No index database found on physical disk.)`,
                ``,
                `CRITICAL MANDATE FOR AGENT:`,
                `1. 目标仓库暂未建立 code-memory 本地高维依赖网，当前严禁强行调用 get_repo_map 或 get_context_pack 等依赖数据库的重型检索工具。`,
                `2. 终止盲目的任务代码推导。你必须立即引导用户在主机的项目终端路径下拉起以下任意一项初始化破冰管线：`,
                `   - 方案 A (推荐：实时守护监听): 运行 code-memory watch . 常驻后台`,
                `   - 方案 B (单次全量扫描): 运行 code-memory index --full 强制编译初始化 AST`,
                `   - 方案 C (完整初始化): 运行 code-memory init && code-memory index --full`,
                `3. 告知用户：一旦 Watch 守卫启动，Tree-sitter 索引流水线会在后台自动完成骨架构建，届时当前阻断将自动解除，高级语义定位能力将自发恢复。`,
              ].join('\n'),
            }],
            isError: false,  // Do NOT block the AI workflow — this is a guidance signal, not an error
          };
        }

        // Other errors: keep original behavior
        log.error("Plan context failed: " + errorMsg);
        return {
          content: [{ type: "text" as const, text: wrapWithStaleBanner(prependIndexDiagnostics("Error: Plan context failed - " + errorMsg, db)) }],
          isError: true,
        };
      }
    },
  );
}

function wrapWithStaleBanner(text: string): string {
  const pending = getActiveWatchState()?.getPendingFiles() ?? [];
  if (pending.length === 0) return text;
  const { inResponse, notInResponse } = partitionPending(pending, text);
  return attachStaleBanner(text, inResponse, notInResponse);
}

function getIndexMetadata(db: SqlJsDatabase): Map<string, string> {
  const rows = db.exec(
    `SELECT key, value
     FROM index_metadata
     WHERE key IN ('current_commit', 'index_completed', 'embedding_provider', 'vector_search')`,
  )[0]?.values ?? [];
  return new Map(rows.map((row) => [String(row[0]), String(row[1])]));
}

function getVectorStatus(metadata: Map<string, string>): "enabled" | "pending" | "disabled" {
  if (metadata.get("vector_search") === "enabled") return "enabled";
  const provider = metadata.get("embedding_provider");
  if (provider && provider !== "none") return "pending";
  return "disabled";
}

function suggestContextLevel(tokenBudget: number): "L0" | "L1" | "L2" | "L3" | "L4" {
  if (tokenBudget <= 500) return "L0";
  if (tokenBudget <= 1500) return "L1";
  if (tokenBudget <= 3000) return "L2";
  if (tokenBudget <= 6000) return "L3";
  return "L4";
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "(none)";
}
