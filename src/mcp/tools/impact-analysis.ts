/**
 * MCP Tool: impact_analysis
 *
 * Analyzes the blast radius of changing a symbol or file.
 * Returns affected files, symbols, related tests, configs,
 * risk points, and call chains.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { ImpactAnalyzer } from "../../graph/impact-analyzer.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:impact-analysis");

export function registerImpactAnalysisTool(server: McpServer, db: SqlJsDatabase): void {
  const analyzer = new ImpactAnalyzer(db);

  server.tool(
    "impact_analysis",
    "Analyze the impact of changing a symbol or file. " +
    "Returns affected files, symbols, related tests, " +
    "configuration files, risk assessment, and call chains. " +
    "Use this before modifying code to understand the blast radius.",
    {
      target: z.string().describe("The symbol name or file path to analyze impact for"),
    },
    async ({ target }) => {
      try {
        const result = analyzer.analyze(target);

        if (result.affectedFiles.length === 0 && result.affectedSymbols.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No impact data found for: " + target + ". The target may not be indexed or has no relationships.",
            }],
          };
        }

        const text = formatImpactResult(result);
        log.info("Impact analysis for " + target + ": " + result.affectedFiles.length + " files, " + result.affectedSymbols.length + " symbols");

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Impact analysis failed: " + msg);
        return {
          content: [{ type: "text" as const, text: "Error: Impact analysis failed - " + msg }],
          isError: true,
        };
      }
    },
  );
}

// ---- Formatting ----

function formatImpactResult(result: {
  target: string;
  affectedFiles: Array<{ path: string; impactType: string; distance: number; reason: string }>;
  affectedSymbols: Array<{ name: string; kind: string; filePath: string; impactType: string; distance: number }>;
  relatedTests: string[];
  relatedConfigs: string[];
  riskPoints: Array<{ description: string; severity: string; filePath: string; symbolName: string | null }>;
  callChain: string[];
}): string {
  const lines: string[] = [];
  lines.push("=== Impact Analysis ===");
  lines.push("Target: " + result.target);
  lines.push("");

  // Risk summary
  if (result.riskPoints.length > 0) {
    lines.push("--- RISK ASSESSMENT ---");
    for (const risk of result.riskPoints) {
      const icon = risk.severity === "critical" ? "!!" :
                   risk.severity === "high" ? "!" :
                   risk.severity === "medium" ? "~" : "-";
      lines.push("  " + icon + " [" + risk.severity.toUpperCase() + "] " + risk.description);
      if (risk.filePath) lines.push("    File: " + risk.filePath);
    }
    lines.push("");
  }

  // Affected files
  if (result.affectedFiles.length > 0) {
    lines.push("--- AFFECTED FILES (" + result.affectedFiles.length + ") ---");
    const sorted = [...result.affectedFiles].sort(function(a, b) { return a.distance - b.distance; });
    for (const file of sorted) {
      lines.push("  [" + file.impactType + " d=" + file.distance + "] " + file.path + " -- " + file.reason);
    }
    lines.push("");
  }

  // Affected symbols
  if (result.affectedSymbols.length > 0) {
    lines.push("--- AFFECTED SYMBOLS (" + result.affectedSymbols.length + ") ---");
    const byType: Record<string, number> = {};
    for (const sym of result.affectedSymbols) {
      byType[sym.impactType] = (byType[sym.impactType] || 0) + 1;
    }
    lines.push("  Callers: " + (byType.caller || 0) +
      " | Callees: " + (byType.callee || 0) +
      " | References: " + (byType.reference || 0));

    for (const sym of result.affectedSymbols.slice(0, 20)) {
      lines.push("  [" + sym.impactType + " d=" + sym.distance + "] " +
        sym.name + " (" + sym.kind + ") at " + sym.filePath);
    }
    if (result.affectedSymbols.length > 20) {
      lines.push("  ... and " + (result.affectedSymbols.length - 20) + " more");
    }
    lines.push("");
  }

  // Call chain
  if (result.callChain.length > 0) {
    lines.push("--- CALL CHAIN ---");
    for (const chain of result.callChain) {
      lines.push("  " + chain);
    }
    lines.push("");
  }

  // Related tests
  if (result.relatedTests.length > 0) {
    lines.push("--- RELATED TESTS (" + result.relatedTests.length + ") ---");
    for (const test of result.relatedTests.slice(0, 10)) {
      lines.push("  " + test);
    }
    if (result.relatedTests.length > 10) {
      lines.push("  ... and " + (result.relatedTests.length - 10) + " more");
    }
    lines.push("");
  }

  // Related configs
  if (result.relatedConfigs.length > 0) {
    lines.push("--- RELATED CONFIGS (" + result.relatedConfigs.length + ") ---");
    for (const config of result.relatedConfigs) {
      lines.push("  " + config);
    }
    lines.push("");
  }

  if (result.riskPoints.length === 0) {
    lines.push("Risk: LOW -- No high-risk patterns detected.");
  }

  return lines.join("\n");
}
