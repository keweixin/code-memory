/**
 * MCP Tool: get_community
 *
 * Returns the details of a single functional community by name: cohesion,
 * member count, top keywords, and a list of member symbols with file:line
 * locations. Communities are produced by the indexer's post-graph phase.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";
import { createLogger } from "../../shared/logger.js";
import { safeJsonParse } from "../../shared/utils.js";
import { withRepoDatabase } from "../repo-router.js";
import { attachStaleBanner, partitionPending } from "./_stale-banner.js";

const log = createLogger("mcp:get-community");

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

export function registerGetCommunityTool(server: McpServer, _db: SqlJsDatabase): void {
  server.tool(
    "get_community",
    "Get the details of a single functional community by name: cohesion, " +
    "member count, top keywords, and a list of member symbols with file:line. " +
    "Communities group symbols that are tightly connected by CALLS, IMPORTS, " +
    "and EXTENDS edges. Use this after get_repo_map to drill into a specific cluster.",
    {
      name: z.string().describe("The name of the community to retrieve"),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ name, repo }) => {
      try {
        return await withRepoDatabase(repo, _db, async (activeDb) => {
          const text = loadCommunity(activeDb, name);
          log.info(`Returned community: ${name}`);
          return {
            content: [{ type: "text" as const, text: wrapWithStaleBanner(text, activeDb) }],
          };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: wrapWithStaleBanner(`=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory watch .\` or \`code-memory index --full\` in your terminal first.`, _db),
            }],
            isError: false,
          };
        }

        log.error(`Failed to get community: ${errorMsg}`);
        return {
          content: [{ type: "text" as const, text: wrapWithStaleBanner(`Error: Failed to get community - ${errorMsg}`, _db) }],
          isError: true,
        };
      }
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────

interface MemberRow {
  symbol_id: string;
  symbol_name: string;
  symbol_kind: string;
  start_line: number;
  end_line: number;
  file_path: string | null;
}

function loadCommunity(db: SqlJsDatabase, name: string): string {
  const communityRows = db.all<{
    id: string;
    name: string;
    cohesion: number;
    symbol_count: number;
    keywords: string;
    detection_method: string;
    top_entry_symbols: string;
    last_indexed: string | null;
  }>(
    'SELECT id, name, cohesion, symbol_count, keywords, detection_method, top_entry_symbols, last_indexed FROM communities WHERE name = ?',
    [name],
  );

  if (communityRows.length === 0) {
    return `No community found with name: ${name}\n` +
      `Tip: Run \`code-memory index\` to (re)build communities, or use get_repo_map to discover available communities.`;
  }

  const community = communityRows[0]!;
  const memberRows = db.all<MemberRow>(
    `SELECT cm.symbol_id,
            s.name          AS symbol_name,
            s.kind          AS symbol_kind,
            s.start_line    AS start_line,
            s.end_line      AS end_line,
            f.path          AS file_path
     FROM community_members cm
     LEFT JOIN symbols s ON s.id = cm.symbol_id
     LEFT JOIN files f ON f.id = cm.file_id
     WHERE cm.community_id = ?
     ORDER BY f.path, s.start_line, s.start_column`,
    [community.id],
  );

  const keywords = parseStringList(community.keywords);
  const topEntrySymbols = parseStringList(community.top_entry_symbols);

  const lines: string[] = [];
  lines.push(`=== Community: ${community.name} ===`);
  lines.push("");
  lines.push(`ID:              ${community.id}`);
  lines.push(`Detection:       ${community.detection_method}`);
  lines.push(`Cohesion:        ${community.cohesion.toFixed(3)}`);
  lines.push(`Member count:    ${community.symbol_count} (persisted: ${memberRows.length})`);
  if (community.last_indexed) {
    lines.push(`Last indexed:    ${community.last_indexed}`);
  }
  if (keywords.length > 0) {
    lines.push(`Keywords:        ${keywords.join(", ")}`);
  }
  if (topEntrySymbols.length > 0) {
    lines.push(`Top entries:     ${topEntrySymbols.join(", ")}`);
  }

  lines.push("");
  lines.push("--- Members ---");
  if (memberRows.length === 0) {
    lines.push("(no member symbols recorded)");
  } else {
    for (const member of memberRows) {
      const filePath = member.file_path ?? "(unknown file)";
      const startLine = member.start_line ?? 0;
      const symbolName = member.symbol_name ?? member.symbol_id;
      const symbolKind = member.symbol_kind ?? "symbol";
      lines.push(`  ${symbolName} [${symbolKind}] (${filePath}:${startLine})`);
    }
  }

  return lines.join("\n");
}

function parseStringList(json: string): string[] {
  const parsed = safeJsonParse<unknown>(json);
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === "string");
  }
  return [];
}
