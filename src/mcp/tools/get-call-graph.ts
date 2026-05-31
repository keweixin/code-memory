/**
 * MCP Tool: get_call_graph
 *
 * Returns the call graph around a symbol: who calls it (callers)
 * and what it calls (callees), with configurable traversal depth.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { GraphEngine } from "../../graph/graph-engine.js";
import { resolveTargetId } from "../../graph/target-resolver.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:get-call-graph");

export function registerGetCallGraphTool(server: McpServer, db: SqlJsDatabase): void {
  const graphEngine = new GraphEngine(db);

  server.tool(
    "get_call_graph",
    "Get the call graph around a symbol. Shows who calls this symbol " +
    "(callers) and what this symbol calls (callees). Use this to " +
    "understand the dependency chain before making changes.",
    {
      symbolName: z.string().describe("The name of the symbol to analyze (e.g. function name)"),
      depth: z.number().describe("How many levels of calls to traverse (1-5, default 2)").optional().default(2),
    },
    async ({ symbolName, depth }) => {
      try {
        const symbolId = resolveTargetId(db, symbolName);
        if (!symbolId) {
          return {
            content: [{
              type: "text" as const,
              text: "No symbol found for: " + symbolName + ". Try search_symbols to find the correct name.",
            }],
          };
        }

        const maxDepth = Math.min(Math.max(depth, 1), 5);
        const subGraph = graphEngine.getCallGraph(symbolId, maxDepth);

        if (subGraph.nodes.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No call graph edges found for: " + symbolName + ". The symbol may not call or be called by other indexed symbols.",
            }],
          };
        }

        const text = formatCallGraph(symbolName, subGraph);
        log.info("Call graph for " + symbolName + ": " + subGraph.nodes.length + " nodes, " + subGraph.edges.length + " edges");

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Get call graph failed: " + msg);
        return {
          content: [{ type: "text" as const, text: "Error: Get call graph failed - " + msg }],
          isError: true,
        };
      }
    },
  );
}

// ---- Helpers ----

function formatCallGraph(
  symbolName: string,
  subGraph: {
    nodes: Array<{
      id: string;
      type: string;
      label: string;
      kind: string;
      filePath: string | null;
      lineRange: [number, number] | null;
      columnRange: [number, number] | null;
    }>;
    edges: Array<{ from: string; to: string; type: string; confidence: number }>;
  },
): string {
  const lines: string[] = [];
  lines.push("=== Call Graph for: " + symbolName + " ===");
  lines.push("Nodes: " + subGraph.nodes.length + " | Edges: " + subGraph.edges.length);
  lines.push("");

  // Build a lookup for node labels
  const nodeLabels = new Map<string, string>();
  for (const node of subGraph.nodes) {
    const loc = formatNodeLocation(node);
    nodeLabels.set(node.id, node.label + " [" + node.kind + "]" + loc);
  }

  // Show the center node
  lines.push("--- Center ---");
  const centerNode = subGraph.nodes[0];
  if (centerNode) {
    lines.push("  " + nodeLabels.get(centerNode.id));
  }
  lines.push("");

  // Show callers (incoming edges)
  const callers = subGraph.edges.filter((e) => e.from !== subGraph.nodes[0]?.id);
  const callees = subGraph.edges.filter((e) => e.from === subGraph.nodes[0]?.id);

  // Group: who calls the center
  const callerMap = new Map<string, string[]>();
  for (const edge of callers) {
    const existing = callerMap.get(edge.from) || [];
    existing.push(edge.to);
    callerMap.set(edge.from, existing);
  }

  // Group: what the center calls
  const calleeMap = new Map<string, string[]>();
  for (const edge of callees) {
    const existing = calleeMap.get(edge.to) || [];
    existing.push("CALLS");
    calleeMap.set(edge.to, existing);
  }

  if (callerMap.size > 0) {
    lines.push("--- Called By (" + callerMap.size + " callers) ---");
    for (const [callerId] of callerMap) {
      const label = nodeLabels.get(callerId) || callerId;
      lines.push("  " + label);
    }
    lines.push("");
  }

  if (calleeMap.size > 0) {
    lines.push("--- Calls (" + calleeMap.size + " callees) ---");
    for (const [calleeId] of calleeMap) {
      const label = nodeLabels.get(calleeId) || calleeId;
      lines.push("  " + label);
    }
    lines.push("");
  }

  if (callerMap.size === 0 && calleeMap.size === 0) {
    lines.push("No call relationships found for this symbol.");
  }

  // Edge details
  if (subGraph.edges.length > 0) {
    lines.push("--- All Edges ---");
    for (const edge of subGraph.edges) {
      const fromLabel = nodeLabels.get(edge.from) || edge.from;
      const toLabel = nodeLabels.get(edge.to) || edge.to;
      lines.push("  " + fromLabel + " --[" + edge.type + "]--> " + toLabel +
        " (conf: " + edge.confidence.toFixed(1) + ")");
    }
  }

  return lines.join("\n");
}

function formatNodeLocation(node: {
  filePath: string | null;
  lineRange: [number, number] | null;
  columnRange: [number, number] | null;
}): string {
  if (!node.filePath) return "";
  if (!node.lineRange) return " (" + node.filePath + ")";
  if (!node.columnRange) return " (" + node.filePath + ":" + node.lineRange[0] + "-" + node.lineRange[1] + ")";
  return " (" + node.filePath + ":" + node.lineRange[0] + ":" + node.columnRange[0] +
    "-" + node.lineRange[1] + ":" + node.columnRange[1] + ")";
}
