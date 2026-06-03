/**
 * MCP Tool: get_process
 *
 * Returns a Process (execution flow) by name. The name may be either a
 * URL pattern (e.g. `GET /users/:id`) or a function name (`main`).
 *
 * The response includes the process metadata (entry point, kind,
 * framework, depth limit, step count) and an ordered list of
 * `STEP_IN_PROCESS` symbols with their file:line locations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";
import { createLogger } from "../../shared/logger.js";
import { withRepoDatabase } from "../repo-router.js";
import { attachStaleBanner, partitionPending } from "./_stale-banner.js";

const log = createLogger("mcp:get-process");

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

interface ProcessRow {
  id: string;
  name: string;
  entry_point: string;
  entry_kind: string;
  framework: string | null;
  depth_limit: number;
  step_count: number;
  last_indexed: string | null;
}

interface ProcessStepRow {
  step: number;
  symbol_id: string | null;
  file_id: string | null;
  edge_id: string | null;
  label: string | null;
  symbol_name: string | null;
  symbol_kind: string | null;
  start_line: number | null;
  end_line: number | null;
  file_path: string | null;
}

export function registerGetProcessTool(server: McpServer, _db: SqlJsDatabase): void {
  server.tool(
    "get_process",
    "Get an execution flow (process) by name. The name can be a URL " +
      "pattern (e.g. 'GET /users/:id') or a function name ('main'). " +
      "Returns the entry point, framework, depth limit, and the ordered " +
      "list of steps with file:line locations. Use this to understand how " +
      "a request flows through the code or where a CLI entry point " +
      "reaches a terminal side-effect.",
    {
      name: z.string().describe("The process name to look up, e.g. 'GET /users/:id' or 'main'"),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ name, repo }) => {
      try {
        return await withRepoDatabase(repo, _db, async (activeDb) => {
          const text = loadProcess(activeDb, name);
          log.info(`Returned process: ${name}`);
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

        log.error(`Failed to get process: ${errorMsg}`);
        return {
          content: [{ type: "text" as const, text: wrapWithStaleBanner(`Error: Failed to get process - ${errorMsg}`, _db) }],
          isError: true,
        };
      }
    },
  );
}

function loadProcess(db: SqlJsDatabase, name: string): string {
  const processes = db.all<ProcessRow>(
    `SELECT id, name, entry_point, entry_kind, framework, depth_limit, step_count, last_indexed
     FROM processes
     WHERE name = ?
     ORDER BY last_indexed DESC
     LIMIT 1`,
    [name],
  );

  if (processes.length === 0) {
    return `No process found with name: ${name}\n` +
      `Tip: Run \`code-memory index\` to (re)build processes, or use get_route_map / search_symbols to discover entry points.`;
  }

  const process = processes[0]!;
  const stepRows = db.all<ProcessStepRow>(
    `SELECT ps.step, ps.symbol_id, ps.file_id, ps.edge_id, ps.label,
            s.name        AS symbol_name,
            s.kind        AS symbol_kind,
            s.start_line  AS start_line,
            s.end_line    AS end_line,
            f.path        AS file_path
     FROM process_steps ps
     LEFT JOIN symbols s ON s.id = ps.symbol_id
     LEFT JOIN files   f ON f.id = ps.file_id
     WHERE ps.process_id = ?
     ORDER BY ps.step`,
    [process.id],
  );

  const lines: string[] = [];
  lines.push(`=== Process: ${process.name} ===`);
  lines.push("");
  lines.push(`ID:            ${process.id}`);
  lines.push(`Entry kind:    ${process.entry_kind}`);
  if (process.framework) {
    lines.push(`Framework:     ${process.framework}`);
  }
  lines.push(`Entry symbol:  ${process.entry_point}`);
  lines.push(`Depth limit:   ${process.depth_limit}`);
  lines.push(`Step count:    ${process.step_count} (persisted: ${stepRows.length})`);
  if (process.last_indexed) {
    lines.push(`Last indexed:  ${process.last_indexed}`);
  }

  lines.push("");
  lines.push("--- Steps ---");
  if (stepRows.length === 0) {
    lines.push("(no steps recorded — the entry symbol may not have any outgoing CALLS / IMPORTS edges)");
  } else {
    for (const step of stepRows) {
      const label = step.label ?? "step";
      const symbolName = step.symbol_name ?? step.symbol_id ?? "(no symbol)";
      const symbolKind = step.symbol_kind ? ` [${step.symbol_kind}]` : "";
      const filePath = step.file_path ?? "(unknown file)";
      const startLine = step.start_line ?? 0;
      lines.push(`  ${step.step}. ${label} — ${symbolName}${symbolKind} (${filePath}:${startLine})`);
    }
  }

  return lines.join("\n");
}
