/**
 * MCP Tool: get_route_map
 *
 * Shows framework route handlers and indexed client fetch references.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";
import { createLogger } from "../../shared/logger.js";
import { withRepoDatabase } from "../repo-router.js";
import { attachStaleBanner, partitionPending } from "./_stale-banner.js";

const log = createLogger("mcp:get-route-map");

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

interface RouteEndpointView {
  id: string;
  route_path: string;
  http_method: string;
  framework: string;
  file_path: string;
  symbol_name: string | null;
  start_line: number;
}

interface RouteReferenceView {
  route_path: string;
  http_method: string | null;
  framework: string;
  file_path: string;
  symbol_name: string | null;
  start_line: number;
  resolution_status: string;
}

export function registerGetRouteMapTool(server: McpServer, db: SqlJsDatabase): void {
  server.tool(
    "get_route_map",
    "Show route handlers and client route references discovered during indexing. " +
      "Use this to trace frontend fetch calls to backend route handlers.",
    {
      route: z.string().optional().describe("Optional route path filter, for example /api/users"),
      includeUnresolved: z.boolean().optional().describe("Include route references that did not resolve to a handler"),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ route, includeUnresolved, repo }) => {
      try {
        return await withRepoDatabase(repo, db, async (activeDb) => {
          const endpoints = loadEndpoints(activeDb, route);
          const references = loadReferences(activeDb, route, Boolean(includeUnresolved));
          const text = formatRouteMap(endpoints, references);
          log.info("Route map: " + endpoints.length + " endpoints, " + references.length + " references");
          return { content: [{ type: "text" as const, text: wrapWithStaleBanner(text, activeDb) }] };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: wrapWithStaleBanner(`=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory watch .\` or \`code-memory index --full\` in your terminal first.`, db),
            }],
            isError: false,
          };
        }

        log.error("Route map failed: " + errorMsg);
        return {
          content: [{ type: "text" as const, text: wrapWithStaleBanner("Error: route map failed - " + errorMsg, db) }],
          isError: true,
        };
      }
    },
  );
}

function loadEndpoints(db: SqlJsDatabase, route?: string): RouteEndpointView[] {
  const params: string[] = [];
  let where = "";
  if (route) {
    where = "WHERE re.route_path = ?";
    params.push(route);
  }
  return db.all<RouteEndpointView>(
    `SELECT re.id, re.route_path, re.http_method, re.framework,
            f.path AS file_path, s.name AS symbol_name, re.start_line
     FROM route_endpoints re
     JOIN files f ON f.id = re.file_id
     LEFT JOIN symbols s ON s.id = re.symbol_id
     ${where}
     ORDER BY re.route_path, re.http_method, f.path`,
    params,
  );
}

function loadReferences(db: SqlJsDatabase, route?: string, includeUnresolved = false): RouteReferenceView[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (route) {
    clauses.push("rr.route_path = ?");
    params.push(route);
  }
  if (!includeUnresolved) {
    clauses.push("rr.resolution_status != 'unresolved'");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : "";
  return db.all<RouteReferenceView>(
    `SELECT rr.route_path, rr.http_method, rr.framework,
            f.path AS file_path, s.name AS symbol_name, rr.start_line, rr.resolution_status
     FROM route_references rr
     JOIN files f ON f.id = rr.file_id
     LEFT JOIN symbols s ON s.id = rr.caller_symbol_id
     ${where}
     ORDER BY rr.route_path, f.path, rr.start_line`,
    params,
  );
}

function formatRouteMap(endpoints: RouteEndpointView[], references: RouteReferenceView[]): string {
  const lines: string[] = [];
  lines.push("=== Route Map ===");
  lines.push(`Endpoints: ${endpoints.length} | References: ${references.length}`);
  lines.push("");

  if (endpoints.length === 0) {
    lines.push("No route endpoints found. Run a full index after adding route-capable files.");
  } else {
    lines.push("--- ENDPOINTS ---");
    for (const endpoint of endpoints) {
      lines.push(
        `  ${endpoint.http_method} ${endpoint.route_path} [${endpoint.framework}] ` +
        `${endpoint.file_path}:${endpoint.start_line}` +
        (endpoint.symbol_name ? ` (${endpoint.symbol_name})` : ""),
      );
    }
  }

  if (references.length > 0) {
    lines.push("");
    lines.push("--- REFERENCES ---");
    for (const reference of references) {
      lines.push(
        `  ${reference.http_method || "ANY"} ${reference.route_path} [${reference.resolution_status}] ` +
        `${reference.file_path}:${reference.start_line}` +
        (reference.symbol_name ? ` (${reference.symbol_name})` : ""),
      );
    }
  }

  return lines.join("\n");
}
