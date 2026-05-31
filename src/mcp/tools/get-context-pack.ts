/**
 * MCP Tool: get_context_pack
 *
 * Searches the codebase and packs relevant context for AI consumption.
 * Uses HybridSearchEngine to find relevant code and ContextPacker
 * to organize it into a token-budgeted context pack.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { HybridSearchEngine } from "../../search/hybrid-search.js";
import type { VectorSearchProvider } from "../../search/vector-search.js";
import { ContextPacker } from "../../search/context-packer.js";
import { getContextDelta, markContextUsed } from "../../memory/context-ledger.js";
import type { ContextDelta, ContextPack, ContextSnippet, ContextSymbol } from "../../shared/types.js";
import { estimateTokens } from "../../shared/token-counter.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:get-context-pack");

export function registerGetContextPackTool(
  server: McpServer,
  db: SqlJsDatabase,
  vectorSearchProvider?: VectorSearchProvider | null,
): void {
  const searchEngine = new HybridSearchEngine(db, undefined, vectorSearchProvider || undefined);
  const packer = new ContextPacker(db);

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
    },
    async ({ query, tokenBudget, levels, sessionId, avoidRepeated }) => {
      try {
        const budget = Math.min(tokenBudget, 12000);

        // Phase 1: Search
        log.info("Searching for: " + query);
        const results = await searchEngine.searchCode(query, {
          limit: 20,
        });

        // Phase 2: Pack
        const pack = await packer.pack(query, results, {
          tokenBudget: budget,
          includeProjectCard: true,
          includeMemories: true,
          maxLevel: levels,
        });

        let ledgerText = "";
        if (sessionId) {
          const candidates = collectPackContext(pack);
          const delta = getContextDelta(sessionId, candidates);
          const omitted = avoidRepeated ? omitRepeatedContext(pack, delta, sessionId) : false;
          const finalContext = collectPackContext(pack);
          if (omitted) {
            pack.tokensUsed = estimatePackTokens(pack);
          }
          const baseText = packer.formatAsText(pack);
          const entryId = markContextUsed({
            sessionId,
            query,
            returnedFiles: finalContext.files,
            returnedSymbols: finalContext.symbols,
            returnedChunks: finalContext.chunks,
            tokenEstimate: estimateTokens(baseText),
            evidenceIds: finalContext.evidenceIds,
          });
          ledgerText = formatLedgerSection(sessionId, delta, entryId, omitted);
        }

        // Phase 3: Format
        const text = [ledgerText, packer.formatAsText(pack)].filter(Boolean).join("\n\n");
        log.info("Context pack: level=" + pack.level + ", tokens=" + pack.tokensUsed + "/" + budget);

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Get context pack failed: " + msg);
        return {
          content: [{ type: "text" as const, text: "Error: Get context pack failed - " + msg }],
          isError: true,
        };
      }
    },
  );
}

function collectPackContext(pack: ContextPack): {
  files: string[];
  symbols: string[];
  chunks: string[];
  evidenceIds: string[];
} {
  const files = unique(pack.files.map((file) => file.path));
  const symbols = unique(pack.symbols.map(symbolKey));
  const chunks = unique(pack.codeSnippets.map(snippetKey));
  const evidenceIds = unique([
    ...symbols.map((symbol) => "symbol:" + symbol),
    ...chunks.map((chunk) => "chunk:" + chunk),
  ]);

  return { files, symbols, chunks, evidenceIds };
}

function omitRepeatedContext(pack: ContextPack, delta: ContextDelta, sessionId: string): boolean {
  const newFiles = new Set(delta.newFiles);
  const newSymbols = new Set(delta.newSymbols);
  const newChunks = new Set(delta.newChunks);
  const repeatedCount =
    delta.repeatedFiles.length + delta.repeatedSymbols.length + delta.repeatedChunks.length;

  if (repeatedCount === 0) return false;

  pack.files = pack.files.filter((file) => newFiles.has(file.path));
  pack.symbols = pack.symbols.filter((symbol) => newSymbols.has(symbolKey(symbol)));
  pack.codeSnippets = pack.codeSnippets.filter((snippet) => newChunks.has(snippetKey(snippet)));
  pack.missing.push("Repeated context omitted for session " + sessionId + ".");
  return true;
}

function estimatePackTokens(pack: ContextPack): number {
  return estimateTokens(JSON.stringify(pack.projectCard || "")) +
    estimateTokens(pack.relevantMemories.map((memory) => memory.content).join("\n")) +
    estimateTokens(pack.files.map((file) => file.path + " " + file.reason).join("\n")) +
    estimateTokens(pack.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.filePath,
      symbol.signature || "",
      symbol.summary || "",
    ].join(" ")).join("\n")) +
    pack.codeSnippets.reduce((sum, snippet) => sum + snippet.tokenCount, 0) +
    estimateTokens(pack.callChains.join("\n")) +
    estimateTokens(pack.missing.join("\n"));
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

function symbolKey(symbol: ContextSymbol): string {
  return [
    symbol.filePath,
    symbol.name,
    symbol.kind,
    symbol.lineRange[0],
    symbol.lineRange[1],
  ].join(":");
}

function snippetKey(snippet: ContextSnippet): string {
  return [
    snippet.filePath,
    snippet.symbolName || "file",
    snippet.lineRange[0],
    snippet.lineRange[1],
  ].join(":");
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
