/**
 * MCP Tool: get_related_tests
 *
 * Finds test files and test symbols related to a source file
 * or symbol. Uses graph edges (TESTS type), call relationships,
 * and naming convention heuristics.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { GraphEngine } from "../../graph/graph-engine.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:get-related-tests");

export function registerGetRelatedTestsTool(server: McpServer, db: SqlJsDatabase): void {
  const graphEngine = new GraphEngine(db);

  server.tool(
    "get_related_tests",
    "Find tests related to a source file or symbol. " +
    "Uses graph relationships and naming conventions to " +
    "identify test files that cover the given code. " +
    "Use this to know which tests to run after making changes.",
    {
      target: z.string().describe("File path or symbol name to find related tests for"),
    },
    async ({ target }) => {
      try {
        const testResults = findRelatedTests(db, graphEngine, target);

        if (testResults.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No related tests found for: " + target + ".",
            }],
          };
        }

        const text = formatTestResults(target, testResults);
        log.info("Found " + testResults.length + " related tests for: " + target);

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Get related tests failed: " + msg);
        return {
          content: [{ type: "text" as const, text: "Error: Get related tests failed - " + msg }],
          isError: true,
        };
      }
    },
  );
}

interface TestInfo {
  filePath: string;
  method: string;
  details: string;
}

function findRelatedTests(
  db: SqlJsDatabase,
  graphEngine: GraphEngine,
  target: string,
): TestInfo[] {
  const tests: TestInfo[] = [];
  const seen = new Set<string>();

  const isFilePath = target.includes("/") || target.includes(".") || target.includes("\\\\");
  const fileId = isFilePath ? findFileId(db, target) : null;
  const symbolId = isFilePath ? null : findSymbolIdByName(db, target);

  // Direct TESTS edges
  if (symbolId) {
    const testEdges = graphEngine.getIncomingNeighbors(symbolId, "TESTS");
    for (const edge of testEdges) {
      const symInfo = getSymbolInfo(db, edge.from);
      if (symInfo && !seen.has(symInfo.filePath)) {
        seen.add(symInfo.filePath);
        tests.push({
          filePath: symInfo.filePath,
          method: "graph (TESTS edge)",
          details: "Test symbol: " + symInfo.name,
        });
      }
    }
  }

  // Naming conventions
  const searchPath = isFilePath ? target : (symbolId ? findSymbolFilePath(db, symbolId) : target);
  if (searchPath) {
    const conventionTests = findTestsByNamingConvention(db, searchPath);
    for (const t of conventionTests) {
      if (!seen.has(t.filePath)) {
        seen.add(t.filePath);
        tests.push(t);
      }
    }
  }

  // Test files that import from this file
  if (fileId) {
    try {
      const results = db.exec(
        "SELECT f2.path FROM edges e JOIN files f2 ON e.from_id = f2.id " +
        "WHERE e.to_id = ? AND e.type = 'IMPORTS' AND f2.role = 'test' LIMIT 20",
        [fileId],
      );
      if (results.length > 0) {
        for (const row of results[0].values) {
          const testPath = String(row[0]);
          if (!seen.has(testPath)) {
            seen.add(testPath);
            tests.push({
              filePath: testPath,
              method: "import graph",
              details: "Test file imports from this module",
            });
          }
        }
      }
    } catch {
      // fall through
    }
  }

  return tests;
}

function findFileId(db: SqlJsDatabase, path: string): string | null {
  try {
    const results = db.exec("SELECT id FROM files WHERE path = ?", [path]);
    if (results.length > 0 && results[0].values.length > 0) {
      return String(results[0].values[0][0]);
    }
  } catch { /* not found */ }
  return null;
}

function findSymbolIdByName(db: SqlJsDatabase, name: string): string | null {
  try {
    const results = db.exec("SELECT id FROM symbols WHERE name = ? LIMIT 1", [name]);
    if (results.length > 0 && results[0].values.length > 0) {
      return String(results[0].values[0][0]);
    }
  } catch { /* not found */ }
  return null;
}

function findSymbolFilePath(db: SqlJsDatabase, symbolId: string): string | null {
  try {
    const results = db.exec(
      "SELECT f.path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.id = ?",
      [symbolId],
    );
    if (results.length > 0 && results[0].values.length > 0) {
      return String(results[0].values[0][0]);
    }
  } catch { /* not found */ }
  return null;
}

function getSymbolInfo(db: SqlJsDatabase, symbolId: string): { name: string; filePath: string } | null {
  try {
    const results = db.exec(
      "SELECT s.name, f.path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.id = ?",
      [symbolId],
    );
    if (results.length > 0 && results[0].values.length > 0) {
      return {
        name: String(results[0].values[0][0]),
        filePath: String(results[0].values[0][1]),
      };
    }
  } catch { /* not found */ }
  return null;
}

function findTestsByNamingConvention(db: SqlJsDatabase, sourcePath: string): TestInfo[] {
  const tests: TestInfo[] = [];
  const lastDot = sourcePath.lastIndexOf(".");
  const baseName = lastDot > 0 ? sourcePath.substring(0, lastDot) : sourcePath;
  const ext = lastDot > 0 ? sourcePath.substring(lastDot) : "";
  const lastSlash = sourcePath.lastIndexOf("/");
  const dir = lastSlash > 0 ? sourcePath.substring(0, lastSlash) : "";
  const fileName = lastSlash > 0 ? sourcePath.substring(lastSlash + 1) : sourcePath;

  const candidates: string[] = [];
  candidates.push(baseName + ".test" + ext);
  candidates.push(baseName + ".spec" + ext);
  candidates.push(baseName + ".test.ts");
  candidates.push(baseName + ".spec.ts");
  candidates.push(baseName + ".test.js");
  candidates.push(baseName + ".spec.js");
  candidates.push(dir + "/__tests__/" + fileName);
  candidates.push(dir + "/tests/" + fileName);

  for (const candidate of candidates) {
    try {
      const results = db.exec(
        "SELECT path FROM files WHERE path = ? AND role = 'test'",
        [candidate],
      );
      if (results.length > 0 && results[0].values.length > 0) {
        tests.push({
          filePath: String(results[0].values[0][0]),
          method: "naming convention",
          details: "Matches test naming: " + candidate,
        });
      }
    } catch {
      // skip
    }
  }

  return tests;
}

function formatTestResults(target: string, tests: TestInfo[]): string {
  const lines: string[] = [];
  lines.push("=== Related Tests for: " + target + " ===");
  lines.push("Found " + tests.length + " related test(s)");
  lines.push("");

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    lines.push((i + 1) + ". " + t.filePath);
    lines.push("   Method: " + t.method);
    lines.push("   Detail: " + t.details);
    lines.push("");
  }

  if (tests.length > 0) {
    const paths = tests.map(function(t: TestInfo) { return t.filePath; }).join(" ");
    lines.push("Run with: npx vitest run " + paths);
  }

  return lines.join("\n");
}
