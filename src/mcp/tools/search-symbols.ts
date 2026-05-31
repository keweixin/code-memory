/**
 * MCP Tool: search_symbols
 *
 * Search specifically for symbols (functions, classes, types, etc.)
 * by name, signature, or summary content. Supports filtering by
 * symbol kind.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import type { SymbolKind } from "../../shared/types.js";
import { HybridSearchEngine } from "../../search/hybrid-search.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:search-symbols");

const SYMBOL_KINDS = [
  "function", "class", "method", "interface", "type",
  "variable", "constant", "enum", "enum_member", "property",
  "constructor", "module", "namespace", "component", "hook",
  "route", "api_endpoint",
] as const;

export function registerSearchSymbolsTool(server: McpServer, db: SqlJsDatabase): void {
  const searchEngine = new HybridSearchEngine(db);

  server.tool(
    "search_symbols",
    "Search specifically for code symbols (functions, classes, types, interfaces, etc.) " +
    "by name, signature, or summary. Supports filtering by symbol kind. " +
    "Use this when you need to find a specific function, class, or type definition.",
    {
      query: z.string().describe("Symbol name, partial name, or keyword to search for"),
      kind: z
        .enum(SYMBOL_KINDS)
        .describe("Filter results to a specific symbol kind (e.g. 'function', 'class', 'interface')")
        .optional(),
      limit: z.number().describe("Maximum number of results (default 20, max 50)").optional().default(20),
    },
    async ({ query, kind, limit }) => {
      try {
        const results = await searchEngine.searchSymbols(query, {
          kind: kind as SymbolKind | undefined,
          limit: Math.min(limit, 50),
        });

        if (results.length === 0) {
          const kindMsg = kind ? ` of kind '${kind}'` : "";
          return {
            content: [{ type: "text" as const, text: `No symbols found for "${query}"${kindMsg}.\n\nEnsure the codebase has been indexed with 'code-memory index'.` }],
          };
        }

        const text = formatSymbolResults(query, kind, results);
        log.info(`Symbol search "${query}" returned ${results.length} results`);

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Symbol search failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: Symbol search failed - ${msg}` }],
          isError: true,
        };
      }
    },
  );
}

// ── Formatting ───────────────────────────────────────────────

function formatSymbolResults(
  query: string,
  kind: string | undefined,
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
  }>,
): string {
  const lines: string[] = [];
  const kindLabel = kind ? ` (kind: ${kind})` : "";
  lines.push(`Symbol search for: "${query}"${kindLabel}`);
  lines.push(`Found ${results.length} symbols`);
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rank = `${i + 1}.`.padEnd(3);
    const score = `[${r.score.toFixed(2)}]`.padEnd(8);

    lines.push(`${rank} ${score} ${r.name} (${r.kind})`);
    if (r.lineRange) {
      lines.push(`     Location: ${formatLocation(r.filePath, r.lineRange, r.columnRange)}`);
    } else {
      lines.push(`     Location: ${r.filePath}`);
    }
    if (r.snippet) {
      const cleanSnippet = r.snippet.replace(/<</g, "**").replace(/>>/g, "**");
      lines.push(`     Context: ${cleanSnippet}`);
    }
    lines.push(`     Sources: ${r.sources.join("+")}`);
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
