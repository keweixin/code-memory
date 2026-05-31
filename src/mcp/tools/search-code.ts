/**
 * MCP Tool: search_code
 *
 * Hybrid search across files and symbols using keyword (FTS3),
 * optional vector search, and graph expansion.
 * Returns ranked results with snippets and metadata.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { HybridSearchEngine } from "../../search/hybrid-search.js";
import type { VectorSearchProvider } from "../../search/vector-search.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:search-code");

export function registerSearchCodeTool(
  server: McpServer,
  db: SqlJsDatabase,
  vectorSearchProvider?: VectorSearchProvider | null,
): void {
  const searchEngine = new HybridSearchEngine(db, undefined, vectorSearchProvider || undefined);

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
    },
    async ({ query, limit, fileFilter, searchMode }) => {
      try {
        const results = await searchEngine.searchCode(query, {
          limit: Math.min(limit, 50),
          fileFilter: fileFilter || undefined,
          searchMode,
        });

        if (results.length === 0) {
          const modeHint = searchMode === 'graph'
            ? "\n\nGraph mode only expands from indexed symbols that match the query. Try 'hybrid' or 'keyword' mode first if there is no obvious seed symbol."
            : searchMode === 'vector'
              ? "\n\nVector mode only searches indexed chunk embeddings. Configure embeddings, run 'code-memory index --full', and use 'hybrid' or 'keyword' mode if no vectors are present."
            : "";
          return {
            content: [{ type: "text" as const, text: `No results found for "${query}".\n\nTry broadening your query, or ensure the codebase has been indexed with 'code-memory index'.${modeHint}` }],
          };
        }

        const text = formatSearchResults(query, results);
        log.info(`Search "${query}" returned ${results.length} results`);

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Search failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: Search failed - ${msg}` }],
          isError: true,
        };
      }
    },
  );
}

// ── Formatting ───────────────────────────────────────────────

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
  }>,
): string {
  const lines: string[] = [];
  lines.push(`Search results for: "${query}"`);
  lines.push(`Found ${results.length} results`);
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
