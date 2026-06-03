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
import { getActiveWatchState } from "../../indexer/watch-service.js";
import { ImpactAnalyzer } from "../../graph/impact-analyzer.js";
import { createLogger } from "../../shared/logger.js";
import { withRepoDatabase } from "../repo-router.js";
import { attachStaleBanner, partitionPending } from "./_stale-banner.js";

const log = createLogger("mcp:impact-analysis");

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
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ target, repo }) => {
      try {
        return await withRepoDatabase(repo, db, async (activeDb) => {
          const activeAnalyzer = repo ? new ImpactAnalyzer(activeDb) : analyzer;
          const result = activeAnalyzer.analyze(target);

          if (result.affectedFiles.length === 0 && result.affectedSymbols.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: wrapWithStaleBanner("No impact data found for: " + target + ". The target may not be indexed or has no relationships.", activeDb),
              }],
            };
          }

          const text = formatImpactResult(result);
          log.info("Impact analysis for " + target + ": " + result.affectedFiles.length + " files, " + result.affectedSymbols.length + " symbols");

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
              text: wrapWithStaleBanner(`=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory watch .\` or \`code-memory index --full\` in your terminal first.`, db),
            }],
            isError: false,
          };
        }

        log.error("Impact analysis failed: " + errorMsg);
        return {
          content: [{ type: "text" as const, text: wrapWithStaleBanner("Error: Impact analysis failed - " + errorMsg, db) }],
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
      " | References: " + (byType.reference || 0) +
      " | Implementors: " + (byType.implementor || 0));

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
