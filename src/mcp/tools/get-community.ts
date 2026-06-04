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
import { TOOL_CONTEXT_INPUT_SCHEMA } from "../tool-context.js";
import { errorToolResult, formatStructuredToolResult, toolResultFromProject } from "../tool-result.js";
import { attachStaleBanner, partitionPending } from "./_stale-banner.js";

const log = createLogger("mcp:get-community");

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

export function registerGetCommunityTool(server: McpServer, _db?: SqlJsDatabase): void {
  server.tool(
    "get_community",
    "Get the details of a single functional community by name: cohesion, " +
    "member count, top keywords, and a list of member symbols with file:line. " +
    "Communities group symbols that are tightly connected by CALLS, IMPORTS, " +
    "and EXTENDS edges. Use this after get_repo_map to drill into a specific cluster.",
    {
      name: z.string().describe("The name of the community to retrieve"),
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ name, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, _db, async (activeDb, projectRoot, resolution) => {
          const communityResult = loadCommunity(activeDb, name);
          const text = wrapWithStaleBanner(communityResult.display, activeDb);
          log.info(`Returned community: ${name}`);
          return {
            content: [{
              type: "text" as const,
              text: formatStructuredToolResult(toolResultFromProject(
                projectRoot,
                resolution.repoName ?? "",
                activeDb,
                {
                  name,
                  found: communityResult.community !== null,
                  community: communityResult.community,
                  members: communityResult.members,
                  keywords: communityResult.keywords,
                  topEntrySymbols: communityResult.topEntrySymbols,
                },
                text,
                communityResult.community
                  ? {
                      tool: "get_context_pack",
                      reason: "Use get_context_pack for task-specific snippets from this community.",
                    }
                  : {
                      tool: "get_repo_map",
                      reason: "No community matched. Use get_repo_map to discover community names.",
                    },
              )),
            }],
          };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        log.error(`Failed to get community: ${errorMsg}`);
        return {
          content: [{
            type: "text" as const,
            text: formatStructuredToolResult(errorToolResult(
              errorMsg,
              { name },
              wrapWithStaleBanner(`Error: Failed to get community - ${errorMsg}`, _db),
            )),
          }],
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

interface LoadedCommunity {
  community: {
    id: string;
    name: string;
    cohesion: number;
    symbol_count: number;
    detection_method: string;
    last_indexed: string | null;
  } | null;
  members: MemberRow[];
  keywords: string[];
  topEntrySymbols: string[];
  display: string;
}

function loadCommunity(db: SqlJsDatabase, name: string): LoadedCommunity {
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
    return {
      community: null,
      members: [],
      keywords: [],
      topEntrySymbols: [],
      display: `No community found with name: ${name}\n` +
        `Tip: Run \`code-memory index\` to (re)build communities, or use get_repo_map to discover available communities.`,
    };
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

  return {
    community: {
      id: community.id,
      name: community.name,
      cohesion: community.cohesion,
      symbol_count: community.symbol_count,
      detection_method: community.detection_method,
      last_indexed: community.last_indexed,
    },
    members: memberRows,
    keywords,
    topEntrySymbols,
    display: lines.join("\n"),
  };
}

function parseStringList(json: string): string[] {
  const parsed = safeJsonParse<unknown>(json);
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === "string");
  }
  return [];
}
