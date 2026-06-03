/**
 * MCP Tool: find_references
 *
 * Finds all references to a symbol throughout the codebase.
 * Uses graph edges (REFERENCES type) and FTS search to
 * locate usages, imports, and type references.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { getActiveWatchState } from "../../indexer/watch-service.js";
import { GraphEngine } from "../../graph/graph-engine.js";
import { createLogger } from "../../shared/logger.js";
import { withRepoDatabase } from "../repo-router.js";
import { attachStaleBanner, partitionPending } from "./_stale-banner.js";

const log = createLogger("mcp:find-references");

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

export function registerFindReferencesTool(server: McpServer, db: SqlJsDatabase): void {
  const graphEngine = new GraphEngine(db);

  server.tool(
    "find_references",
    "Find all references to a symbol across the codebase. " +
    "Returns file locations, reference types (import, call, type use), " +
    "and surrounding context. Use this to understand how a symbol " +
    "is used before modifying or removing it.",
    {
      symbolName: z.string().describe("The symbol name to find references for"),
      maxResults: z.number().describe("Max references (default 30, max 100)").optional().default(30),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ symbolName, maxResults, repo }) => {
      try {
        return await withRepoDatabase(repo, db, async (activeDb) => {
          const activeGraphEngine = repo ? new GraphEngine(activeDb) : graphEngine;
          const symbolIds = findSymbolIds(activeDb, symbolName);
          if (symbolIds.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: wrapWithStaleBanner("No symbol found for: " + symbolName + ". Run code-memory index first.", activeDb),
              }],
            };
          }

          const refs = collectReferences(activeDb, activeGraphEngine, symbolIds, symbolName, Math.min(maxResults, 100));

          if (refs.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: wrapWithStaleBanner("No references found for: " + symbolName + ".", activeDb),
              }],
            };
          }

          const text = formatReferences(symbolName, symbolIds.length, refs);
          log.info("Found " + refs.length + " references for: " + symbolName);

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
              text: wrapWithStaleBanner(`=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory setup --project .\` for full AI onboarding, or \`code-memory bootstrap --project .\` for index-only initialization.`, db),
            }],
            isError: false,
          };
        }

        log.error("Find references failed: " + errorMsg);
        return {
          content: [{ type: "text" as const, text: wrapWithStaleBanner("Error: Find references failed - " + errorMsg, db) }],
          isError: true,
        };
      }
    },
  );
}

// ---- Data Access ----

interface ReferenceInfo {
  symbolName: string;
  kind: string;
  filePath: string;
  edgeType: string;
  confidence: number;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

function findSymbolIds(db: SqlJsDatabase, name: string): string[] {
  const ids: string[] = [];
  try {
    const results = db.exec(
      "SELECT id FROM symbols WHERE name = ? LIMIT 5",
      [name],
    );
    if (results.length > 0) {
      for (const row of results[0].values) {
        ids.push(String(row[0]));
      }
    }
  } catch {
    // fall through
  }
  return ids;
}

function collectReferences(
  db: SqlJsDatabase,
  graphEngine: GraphEngine,
  symbolIds: string[],
  symbolName: string,
  maxResults: number,
): ReferenceInfo[] {
  const refMap = new Map<string, ReferenceInfo>();

  for (const id of symbolIds) {
    const refEdges = graphEngine.getIncomingNeighbors(id, "REFERENCES");
    for (const edge of refEdges) {
      const info = getEdgeNodeInfo(db, edge.from, edge.type, edge.confidence, symbolName);
      if (info && refMap.size < maxResults * 2) {
        const key = info.filePath + ":" + info.startLine + ":" + info.startColumn;
        if (!refMap.has(key)) refMap.set(key, info);
      }
    }

    if (refMap.size < maxResults * 2) {
      const callEdges = graphEngine.getIncomingNeighbors(id, "CALLS");
      for (const edge of callEdges.slice(0, 10)) {
        const info = getEdgeNodeInfo(db, edge.from, edge.type, edge.confidence, symbolName);
        if (info) {
          const key = info.filePath + ":" + info.startLine + ":" + info.startColumn;
          if (!refMap.has(key)) refMap.set(key, info);
        }
      }
    }

    if (refMap.size < maxResults * 2) {
      const importEdges = graphEngine.getIncomingNeighbors(id, "IMPORTS");
      for (const edge of importEdges.slice(0, 5)) {
        const info = getEdgeNodeInfo(db, edge.from, edge.type, edge.confidence, symbolName);
        if (info) {
          const key = info.filePath + ":" + info.startLine + ":" + info.startColumn;
          if (!refMap.has(key)) refMap.set(key, info);
        }
      }
    }
  }

  if (refMap.size < maxResults) {
    try {
      const ftsResults = db.exec(
        "SELECT s.name, s.kind, s.file_id, s.start_line, s.end_line, s.start_column, s.end_column " +
        "FROM symbols_fts fts JOIN symbols s ON s.rowid = fts.docid " +
        "WHERE symbols_fts MATCH ? LIMIT ?",
        ["name:" + symbolName + "*", maxResults * 2],
      );
      if (ftsResults.length > 0) {
        for (const row of ftsResults[0].values) {
          if (String(row[0]) === symbolName) continue;
          const fileId = String(row[2]);
          const filePath = resolveFilePath(db, fileId);
          if (!filePath) continue;

          const key = filePath + ":" + String(row[3]) + ":" + String(row[5]);
          if (!refMap.has(key) && refMap.size < maxResults * 2) {
            refMap.set(key, {
              symbolName: String(row[0]),
              kind: String(row[1]),
              filePath,
              edgeType: "REFERENCES",
              confidence: 0.7,
              startLine: Number(row[3]),
              endLine: Number(row[4]),
              startColumn: Number(row[5]),
              endColumn: Number(row[6]),
            });
          }
        }
      }
    } catch {
      // FTS might fail with special characters
    }
  }

  const refs = Array.from(refMap.values());
  refs.sort((a, b) => b.confidence - a.confidence);
  return refs.slice(0, maxResults);
}

function getEdgeNodeInfo(
  db: SqlJsDatabase,
  nodeId: string,
  edgeType: string,
  confidence: number,
  targetName: string,
): ReferenceInfo | null {
  try {
    const results = db.exec(
      "SELECT name, kind, file_id, start_line, end_line, start_column, end_column FROM symbols WHERE id = ?",
      [nodeId],
    );
    if (results.length > 0 && results[0].values.length > 0) {
      const row = results[0].values[0];
      const filePath = resolveFilePath(db, String(row[2]));
      if (!filePath) return null;

      return {
        symbolName: String(row[0]),
        kind: String(row[1]),
        filePath,
        edgeType,
        confidence,
        startLine: Number(row[3]),
        endLine: Number(row[4]),
        startColumn: Number(row[5]),
        endColumn: Number(row[6]),
      };
    }
  } catch {
    // not a known symbol
  }

  try {
    const results = db.exec(
      "SELECT path, imports FROM files WHERE id = ?",
      [nodeId],
    );
    if (results.length > 0 && results[0].values.length > 0) {
      const row = results[0].values[0];
      const filePath = String(row[0]);
      const importInfo = findImportForSymbol(String(row[1] || "[]"), targetName);

      return {
        symbolName: filePath.split("/").pop() || filePath,
        kind: "file",
        filePath,
        edgeType,
        confidence,
        startLine: importInfo?.startLine || 1,
        endLine: importInfo?.endLine || importInfo?.startLine || 1,
        startColumn: importInfo?.startColumn || 0,
        endColumn: importInfo?.endColumn || importInfo?.startColumn || 0,
      };
    }
  } catch {
    // not a known file
  }
  return null;
}

function findImportForSymbol(importsJson: string, targetName: string): {
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
} | null {
  try {
    const imports = JSON.parse(importsJson) as Array<{
      names?: string[];
      startLine?: number;
      endLine?: number;
      startColumn?: number;
      endColumn?: number;
    }>;
    if (!Array.isArray(imports)) return null;
    return imports.find((imp) => Array.isArray(imp.names) && imp.names.includes(targetName)) || null;
  } catch {
    return null;
  }
}

function resolveFilePath(db: SqlJsDatabase, fileId: string): string | null {
  try {
    const results = db.exec("SELECT path FROM files WHERE id = ?", [fileId]);
    if (results.length > 0 && results[0].values.length > 0) {
      return String(results[0].values[0][0]);
    }
  } catch {
    // fall through
  }
  return null;
}

function formatReferences(symbolName: string, targetCount: number, refs: ReferenceInfo[]): string {
  const lines: string[] = [];
  lines.push("References to \"" + symbolName + "\" (" + targetCount + " definition(s) found)");
  lines.push("Found " + refs.length + " references");
  lines.push("");

  const byFile = new Map<string, ReferenceInfo[]>();
  for (const ref of refs) {
    const existing = byFile.get(ref.filePath) || [];
    existing.push(ref);
    byFile.set(ref.filePath, existing);
  }

  for (const [filePath, fileRefs] of byFile) {
    lines.push("--- " + filePath + " (" + fileRefs.length + " reference(s)) ---");
    for (const ref of fileRefs) {
      const edgeLabel = ref.edgeType === "CALLS" ? "called by" :
                        ref.edgeType === "IMPORTS" ? "imported by" :
                        ref.edgeType === "REFERENCES" ? "referenced by" :
                        ref.edgeType;
      lines.push("  " + formatLocation(ref) + ": " + edgeLabel + " " +
        ref.symbolName + " (" + ref.kind + ") [conf: " + ref.confidence.toFixed(1) + "]");
    }
    lines.push("");
  }

  if (refs.length === 0) {
    lines.push("No references found. The symbol may not be used elsewhere.");
    lines.push("Note: references from external packages are not tracked.");
  }

  return lines.join("\n");
}

function formatLocation(ref: ReferenceInfo): string {
  return ref.filePath + ":" + ref.startLine + ":" + ref.startColumn +
    "-" + ref.endLine + ":" + ref.endColumn;
}
