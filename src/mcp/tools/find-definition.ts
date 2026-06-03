/**
 * MCP Tool: find_definition
 *
 * Finds the exact location of a symbol definition in the codebase.
 * Returns file path, line range, signature, summary, and access level.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { resolveTargetNode } from "../../graph/target-resolver.js";
import { createLogger } from "../../shared/logger.js";
import { withRepoDatabase } from "../repo-router.js";
import {
  attachStaleBanner,
  partitionPending,
} from "./_stale-banner.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";

const log = createLogger("mcp:find-definition");

export function registerFindDefinitionTool(server: McpServer, db: SqlJsDatabase): void {
  server.tool(
    "find_definition",
    "Find the exact location of a symbol's definition. " +
    "Returns file path, line range, signature, summary, and access level. " +
    "Use this when you need to read the source of a specific function, class, or type.",
    {
      symbolName: z.string().describe("The exact or partial name of the symbol to find"),
      filePath: z
        .string()
        .describe("Optional file path to narrow the search scope")
        .optional(),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ symbolName, filePath, repo }) => {
      try {
        return await withRepoDatabase(repo, db, async (activeDb) => {
          const definitions = findDefinitions(activeDb, symbolName, filePath || null);

          if (definitions.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: wrapWithStaleBanner(
                  `No definition found for "${symbolName}".\n\nPossible reasons:\n- The symbol is not indexed yet (run 'code-memory index')\n- The name might be slightly different (use search_symbols to explore)\n- The symbol might be from an external dependency`,
                  activeDb,
                ),
              }],
            };
          }

          const baseText = formatDefinitions(symbolName, definitions);
          const text = wrapWithStaleBanner(baseText, activeDb);
          log.info(`Found ${definitions.length} definition(s) for "${symbolName}"`);

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
              text: `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory watch .\` or \`code-memory index --full\` in your terminal first.`,
            }],
            isError: false,
          };
        }

        log.error(`Find definition failed: ${errorMsg}`);
        return {
          content: [{ type: "text" as const, text: wrapWithStaleBanner(`Error: Find definition failed - ${errorMsg}`, db) }],
          isError: true,
        };
      }
    },
  );
}

// ── Data Access ──────────────────────────────────────────────

interface DefinitionInfo {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  signature: string | null;
  summary: string | null;
  accessLevel: string | null;
  exports: string[];
  imports: string[];
  language: string;
}

function findDefinitions(db: SqlJsDatabase, symbolName: string, filePath: string | null): DefinitionInfo[] {
  const definitions: DefinitionInfo[] = [];

  // Build query - try exact match first, then partial
  let sql = `
    SELECT s.id, s.name, s.kind, f.path AS file_path,
           s.start_line, s.end_line, s.start_column, s.end_column,
           s.signature, s.summary,
           s.access_level, f.exports, f.imports, f.language
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.name LIKE ?
  `;
  const params: string[] = [`%${symbolName}%`];

  if (filePath) {
    sql += " AND f.path = ?";
    params.push(filePath);
  }

  // Prefer exact matches
  sql += " ORDER BY CASE WHEN s.name = ? THEN 0 ELSE 1 END, s.name";
  params.push(symbolName);

  sql += " LIMIT 30";

  try {
    const results = db.exec(sql, params);
    if (results.length > 0 && results[0].values.length > 0) {
      for (const row of results[0].values) {
        definitions.push(rowToDefinition(row));
      }
    }
  } catch {
    // return empty
  }

  if (definitions.length > 0) return definitions;

  const resolvedTarget = resolveTargetNode(db, symbolName);
  if (resolvedTarget?.kind !== "symbol") return [];

  const resolvedDefinition = findDefinitionById(db, resolvedTarget.id, filePath);
  return resolvedDefinition ? [resolvedDefinition] : [];
}

function findDefinitionById(
  db: SqlJsDatabase,
  symbolId: string,
  filePath: string | null,
): DefinitionInfo | null {
  let sql = `
    SELECT s.id, s.name, s.kind, f.path AS file_path,
           s.start_line, s.end_line, s.start_column, s.end_column,
           s.signature, s.summary,
           s.access_level, f.exports, f.imports, f.language
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.id = ?
  `;
  const params: string[] = [symbolId];

  if (filePath) {
    sql += " AND f.path = ?";
    params.push(filePath);
  }

  sql += " LIMIT 1";

  try {
    const results = db.exec(sql, params);
    if (!results.length || !results[0].values.length) return null;
    return rowToDefinition(results[0].values[0]);
  } catch {
    return null;
  }
}

function rowToDefinition(row: unknown[]): DefinitionInfo {
  return {
    id: String(row[0]),
    name: String(row[1]),
    kind: String(row[2]),
    filePath: String(row[3]),
    startLine: Number(row[4]),
    endLine: Number(row[5]),
    startColumn: Number(row[6]),
    endColumn: Number(row[7]),
    signature: row[8] ? String(row[8]) : null,
    summary: row[9] ? String(row[9]) : null,
    accessLevel: row[10] ? String(row[10]) : null,
    exports: safeJsonParseArray(String(row[11])),
    imports: safeJsonParseImportSources(String(row[12])),
    language: String(row[13]),
  };
}

// ── Helpers ──────────────────────────────────────────────────

function safeJsonParseArray(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

function safeJsonParseImportSources(json: string): string[] {
  try {
    const imports = JSON.parse(json);
    if (Array.isArray(imports)) {
      return imports.map((imp: { source?: string }) => imp.source || "").filter(Boolean);
    }
  } catch { /* ignore */ }
  return [];
}

// ── Formatting ───────────────────────────────────────────────

function formatDefinitions(symbolName: string, defs: DefinitionInfo[]): string {
  const lines: string[] = [];

  // Separate exact and partial matches
  const exact = defs.filter((d) => d.name === symbolName);
  const partial = defs.filter((d) => d.name !== symbolName);
  const sorted = [...exact, ...partial];

  lines.push(`Definition search for: "${symbolName}"`);
  lines.push(`Found ${defs.length} match(es)${exact.length > 0 ? ` (${exact.length} exact)` : ""}`);
  lines.push("");

  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i];
    const rank = `${i + 1}.`;
    const isExact = d.name === symbolName;
    const matchLabel = isExact ? " [EXACT MATCH]" : "";

    lines.push(`${rank}${matchLabel} ${d.name} (${d.kind})${d.accessLevel ? ` [${d.accessLevel}]` : ""}`);
    lines.push(`   Location: ${formatLocation(d)}`);
    if (d.signature) {
      lines.push(`   Signature: ${d.signature}`);
    }
    if (d.summary) {
      lines.push(`   Summary: ${d.summary}`);
    }
    if (d.exports.length > 0) {
      lines.push(`   Exports: ${d.exports.slice(0, 10).join(", ")}${d.exports.length > 10 ? ", ..." : ""}`);
    }
    if (d.imports.length > 0) {
      lines.push(`   Imports from: ${d.imports.slice(0, 5).join(", ")}${d.imports.length > 5 ? ", ..." : ""}`);
    }
    lines.push("");
  }

  if (partial.length > 0) {
    lines.push(`Tip: Use a more specific name to narrow results. Try search_symbols for broader exploration.`);
  }

  return lines.join("\n");
}

function formatLocation(d: DefinitionInfo): string {
  return `${d.filePath}:${d.startLine}:${d.startColumn}-${d.endLine}:${d.endColumn}`;
}

function wrapWithStaleBanner(text: string, activeDb: SqlJsDatabase): string {
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
