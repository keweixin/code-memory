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
import { ContextPacker } from "../../search/context-packer.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:get-context-pack");

export function registerGetContextPackTool(server: McpServer, db: SqlJsDatabase): void {
  const searchEngine = new HybridSearchEngine(db);
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
      levels: z.enum(["L0", "L1", "L2", "L3", "L4"]).describe("Minimum context detail level (L0=card, L4=full snippets)").optional(),
    },
    async ({ query, tokenBudget }) => {
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
        });

        // Phase 3: Format
        const text = packer.formatAsText(pack);
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
