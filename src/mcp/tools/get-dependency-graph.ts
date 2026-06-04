/**
 * MCP Tool: get_dependency_graph
 *
 * Returns the import dependency graph for a file or symbol.
 * Shows what modules depend on it and what it depends on.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";
import { GraphEngine } from "../../graph/graph-engine.js";
import { createLogger } from "../../shared/logger.js";
import { withRepoDatabase } from "../repo-router.js";
import { TOOL_CONTEXT_INPUT_SCHEMA } from "../tool-context.js";
import { errorToolResult, formatStructuredToolResult, toolResultFromProject } from "../tool-result.js";
import { attachStaleBanner, partitionPending } from "./_stale-banner.js";

const log = createLogger("mcp:get-dependency-graph");

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

export function registerGetDependencyGraphTool(server: McpServer, db?: SqlJsDatabase): void {
  const graphEngine = db ? new GraphEngine(db) : null;

  server.tool(
    "get_dependency_graph",
    "Get the import dependency graph for a file or symbol. " +
    "Shows what other modules import this file (dependents) and " +
    "what this file imports (dependencies). Use this to understand " +
    "module coupling before refactoring.",
    {
      filePath: z.string().describe("The file path to analyze dependencies for"),
      depth: z.number().describe("How many levels of imports to traverse (1-3, default 2)").optional().default(2),
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ filePath, depth, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, db, async (activeDb, projectRoot, resolution) => {
          const activeGraphEngine = graphEngine && activeDb === db ? graphEngine : new GraphEngine(activeDb);
          const maxDepth = Math.min(Math.max(depth, 1), 3);
          const fileId = findFileId(activeDb, filePath);
          if (!fileId) {
            // Try as partial path match
            const matches = findFilesByPartialPath(activeDb, filePath);
            if (matches.length === 0) {
              const display = wrapWithStaleBanner("No file found matching: " + filePath + ". Ensure the file has been indexed.", activeDb);
              return {
                content: [{
                  type: "text" as const,
                  text: formatStructuredToolResult(toolResultFromProject(
                    projectRoot,
                    resolution.repoName ?? "",
                    activeDb,
                    { filePath, found: false, matches, maxDepth, nodes: [], edges: [] },
                    display,
                    {
                      tool: "search_code",
                      reason: "No file matched. Use search_code or get_repo_map to discover indexed paths.",
                    },
                  )),
                }],
              };
            }
            if (matches.length > 1) {
              const list = matches.map(function(m) { return "  - " + m.path; }).join("\n");
              const display = wrapWithStaleBanner("Multiple files match: " + filePath + ":\n" + list + "\n\nPlease use a more specific path.", activeDb);
              return {
                content: [{
                  type: "text" as const,
                  text: formatStructuredToolResult(toolResultFromProject(
                    projectRoot,
                    resolution.repoName ?? "",
                    activeDb,
                    { filePath, found: false, ambiguous: true, matches, maxDepth, nodes: [], edges: [] },
                    display,
                    {
                      tool: "get_dependency_graph",
                      reason: "Multiple files matched. Call get_dependency_graph again with one exact path.",
                    },
                  )),
                }],
              };
            }
            return analyzeGraph(activeDb, activeGraphEngine, matches[0].id, matches[0].path, maxDepth, projectRoot, resolution.repoName ?? "");
          }

          return analyzeGraph(activeDb, activeGraphEngine, fileId, filePath, maxDepth, projectRoot, resolution.repoName ?? "");
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        log.error("Get dependency graph failed: " + errorMsg);
        return {
          content: [{
            type: "text" as const,
            text: formatStructuredToolResult(errorToolResult(
              errorMsg,
              { filePath, depth },
              wrapWithStaleBanner("Error: Get dependency graph failed - " + errorMsg, db),
            )),
          }],
          isError: true,
        };
      }
    },
  );
}

// ---- Helpers ----

function findFileId(db: SqlJsDatabase, path: string): string | null {
  try {
    const results = db.exec("SELECT id FROM files WHERE path = ?", [path]);
    if (results.length > 0 && results[0].values.length > 0) {
      return String(results[0].values[0][0]);
    }
  } catch {
    // fall through
  }
  return null;
}

function findFilesByPartialPath(db: SqlJsDatabase, partial: string): Array<{ id: string; path: string }> {
  const results: Array<{ id: string; path: string }> = [];
  try {
    const r = db.exec(
      "SELECT id, path FROM files WHERE path LIKE ? LIMIT 10",
      ["%" + partial + "%"],
    );
    if (r.length > 0) {
      for (const row of r[0].values) {
        results.push({ id: String(row[0]), path: String(row[1]) });
      }
    }
  } catch {
    // fall through
  }
  return results;
}

function analyzeGraph(
  db: SqlJsDatabase,
  graphEngine: GraphEngine,
  fileId: string,
  filePath: string,
  depth: number,
  projectRoot: string,
  repoName: string,
): { content: Array<{ type: "text"; text: string }> } {
  const subGraph = graphEngine.getDependencyGraph(fileId, depth);

  if (subGraph.nodes.length === 0) {
    const display = wrapWithStaleBanner("No import dependencies found for: " + filePath + ". The file may have no imports or exports.", db);
    return {
      content: [{
        type: "text" as const,
        text: formatStructuredToolResult(toolResultFromProject(
          projectRoot,
          repoName,
          db,
          { filePath, fileId, found: true, depth, nodes: [], edges: [], fileInfo: getFileInfo(db, filePath) },
          display,
          {
            tool: "get_repo_map",
            reason: "No dependency edges were found. Use get_repo_map to inspect nearby modules.",
          },
        )),
      }],
    };
  }

  const text = wrapWithStaleBanner(formatDependencyGraph(filePath, subGraph, db), db);
  log.info("Dependency graph for " + filePath + ": " + subGraph.nodes.length + " nodes, " + subGraph.edges.length + " edges");

  return {
    content: [{
      type: "text" as const,
      text: formatStructuredToolResult(toolResultFromProject(
        projectRoot,
        repoName,
        db,
        { filePath, fileId, found: true, depth, nodes: subGraph.nodes, edges: subGraph.edges, fileInfo: getFileInfo(db, filePath) },
        text,
        {
          tool: "impact_analysis",
          reason: "Run impact_analysis before refactoring files in this dependency graph.",
        },
      )),
    }],
  };
}

function formatDependencyGraph(
  filePath: string,
  subGraph: { nodes: Array<{ id: string; type: string; label: string; kind: string; filePath: string | null }>; edges: Array<{ from: string; to: string; type: string; confidence: number }> },
  db: SqlJsDatabase,
): string {
  const lines: string[] = [];
  lines.push("=== Dependency Graph for: " + filePath + " ===");
  lines.push("Nodes: " + subGraph.nodes.length + " | Edges: " + subGraph.edges.length);
  lines.push("");

  // Build node label lookup
  const nodeLabels = new Map<string, string>();
  for (const node of subGraph.nodes) {
    nodeLabels.set(node.id, node.label);
  }

  // Center node
  const centerNode = subGraph.nodes[0];
  const centerId = centerNode ? centerNode.id : "";

  // Dependents: who imports this file (incoming IMPORTS)
  const dependents = subGraph.edges.filter(function(e) { return e.to === centerId; });
  // Dependencies: what this file imports (outgoing IMPORTS)
  const dependencies = subGraph.edges.filter(function(e) { return e.from === centerId; });

  // Get file info
  const fileInfo = getFileInfo(db, filePath);

  lines.push("--- File Info ---");
  lines.push("  Language: " + fileInfo.language);
  lines.push("  Role: " + fileInfo.role);
  if (fileInfo.exports.length > 0) {
    lines.push("  Exports: " + fileInfo.exports.slice(0, 10).join(", ") +
      (fileInfo.exports.length > 10 ? ", ..." : ""));
  }
  lines.push("");

  if (dependents.length > 0) {
    lines.push("--- Depends On This (" + dependents.length + " dependents) ---");
    const seen = new Set<string>();
    for (const edge of dependents) {
      const label = nodeLabels.get(edge.from) || edge.from;
      if (!seen.has(label)) {
        seen.add(label);
        lines.push("  " + label + " (conf: " + edge.confidence.toFixed(1) + ")");
      }
    }
    lines.push("");
  }

  if (dependencies.length > 0) {
    lines.push("--- This Depends On (" + dependencies.length + " dependencies) ---");
    const seen = new Set<string>();
    for (const edge of dependencies) {
      const label = nodeLabels.get(edge.to) || edge.to;
      if (!seen.has(label)) {
        seen.add(label);
        lines.push("  " + label + " (conf: " + edge.confidence.toFixed(1) + ")");
      }
    }
    lines.push("");
  }

  if (dependents.length === 0 && dependencies.length === 0) {
    lines.push("No import relationships found. The module may have no imports or is not imported by others.");
  }

  return lines.join("\n");
}

function getFileInfo(db: SqlJsDatabase, path: string): { language: string; role: string; exports: string[] } {
  const info = { language: "unknown", role: "source", exports: [] as string[] };
  try {
    const results = db.exec(
      "SELECT language, role, exports FROM files WHERE path = ?",
      [path],
    );
    if (results.length > 0 && results[0].values.length > 0) {
      const row = results[0].values[0];
      info.language = String(row[0]);
      info.role = String(row[1]);
      try {
        const parsed = JSON.parse(String(row[2]));
        if (Array.isArray(parsed)) info.exports = parsed;
      } catch {
        // keep empty
      }
    }
  } catch {
    // defaults
  }
  return info;
}
