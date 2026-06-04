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
import { getActiveWatchState } from "../../indexer/watch-service.js";
import { GraphEngine } from "../../graph/graph-engine.js";
import { resolveTargetNode } from "../../graph/target-resolver.js";
import { createLogger } from "../../shared/logger.js";
import { withRepoDatabase } from "../repo-router.js";
import { TOOL_CONTEXT_INPUT_SCHEMA } from "../tool-context.js";
import { errorToolResult, formatStructuredToolResult, toolResultFromProject } from "../tool-result.js";
import { attachStaleBanner, partitionPending } from "./_stale-banner.js";

const log = createLogger("mcp:get-related-tests");

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

export function registerGetRelatedTestsTool(server: McpServer, db?: SqlJsDatabase): void {
  const graphEngine = db ? new GraphEngine(db) : null;

  server.tool(
    "get_related_tests",
    "Find tests related to a source file or symbol. " +
    "Uses graph relationships and naming conventions to " +
    "identify test files that cover the given code. " +
    "Use this to know which tests to run after making changes.",
    {
      target: z.string().describe("File path or symbol name to find related tests for"),
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ target, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, db, async (activeDb, projectRoot, resolution) => {
          const activeGraphEngine = graphEngine && activeDb === db ? graphEngine : new GraphEngine(activeDb);
          const testResults = findRelatedTests(activeDb, activeGraphEngine, target);
          if (testResults.length === 0) {
            testResults.push(...findTestsByPathTokenOverlap(activeDb, target));
          }

          if (testResults.length === 0) {
            const display = wrapWithStaleBanner("No related tests found for: " + target + ".", activeDb);
            return {
              content: [{
                type: "text" as const,
                text: formatStructuredToolResult(toolResultFromProject(
                  projectRoot,
                  resolution.repoName ?? "",
                  activeDb,
                  {
                    target,
                    resultCount: 0,
                    tests: testResults,
                  },
                  display,
                  {
                    tool: "search_code",
                    reason: "No related tests were found. Search code for the target to identify nearby test seams.",
                  },
                )),
              }],
            };
          }

          const testEvidence = buildRelatedTestEvidence(activeDb, testResults);
          const text = wrapWithStaleBanner(formatTestResults(target, testResults), activeDb);
          log.info("Found " + testResults.length + " related tests for: " + target);

          return {
            content: [{
              type: "text" as const,
              text: formatStructuredToolResult(toolResultFromProject(
                projectRoot,
                resolution.repoName ?? "",
                activeDb,
                {
                  target,
                  resultCount: testResults.length,
                  tests: testResults,
                  allowedNextReads: testEvidence.allowedNextReads,
                  exactSnippets: testEvidence.exactSnippets,
                  evidence: testEvidence.evidence,
                  relatedTests: testResults.map((test) => ({
                    path: test.filePath,
                    reason: test.details,
                    confidence: test.confidence ?? 0.7,
                  })),
                  runCommand: "npx vitest run " + testResults.map((test) => test.filePath).join(" "),
                },
                text,
                {
                  command: "npx vitest run " + testResults.map((test) => test.filePath).join(" "),
                  reason: "Run the related tests after editing the target code.",
                },
              )),
            }],
          };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        log.error("Get related tests failed: " + errorMsg);
        return {
          content: [{
            type: "text" as const,
            text: formatStructuredToolResult(errorToolResult(
              errorMsg,
              { target },
              wrapWithStaleBanner("Error: Get related tests failed - " + errorMsg, db),
            )),
          }],
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
  confidence?: number;
}

function findRelatedTests(
  db: SqlJsDatabase,
  graphEngine: GraphEngine,
  target: string,
): TestInfo[] {
  const tests: TestInfo[] = [];
  const seen = new Set<string>();

  const resolvedTarget = resolveTargetNode(db, target);
  const symbolId = resolvedTarget?.kind === "symbol" ? resolvedTarget.id : null;
  const fileId = resolvedTarget?.kind === "file"
    ? resolvedTarget.id
    : symbolId
      ? findSymbolFileId(db, symbolId)
      : null;

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
          confidence: 0.95,
        });
      }
    }
  }

  if (fileId) {
    const testEdges = graphEngine.getIncomingNeighbors(fileId, "TESTS");
    for (const edge of testEdges) {
      const testPath = resolveTestPathFromNode(db, edge.from);
      if (testPath && !seen.has(testPath)) {
        seen.add(testPath);
        tests.push({
          filePath: testPath,
          method: "graph (TESTS edge)",
          details: "Test file covers this module",
          confidence: 0.9,
        });
      }
    }
  }

  // Naming conventions
  const searchPath = fileId ? findFilePathById(db, fileId) : target;
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
              confidence: 0.85,
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

function findFilePathById(db: SqlJsDatabase, fileId: string): string | null {
  try {
    const results = db.exec("SELECT path FROM files WHERE id = ?", [fileId]);
    if (results.length > 0 && results[0].values.length > 0) {
      return String(results[0].values[0][0]);
    }
  } catch { /* not found */ }
  return null;
}

function findSymbolFileId(db: SqlJsDatabase, symbolId: string): string | null {
  try {
    const results = db.exec("SELECT file_id FROM symbols WHERE id = ?", [symbolId]);
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

function resolveTestPathFromNode(db: SqlJsDatabase, nodeId: string): string | null {
  try {
    const fileResults = db.exec(
      "SELECT path FROM files WHERE id = ? AND role = 'test'",
      [nodeId],
    );
    if (fileResults.length > 0 && fileResults[0].values.length > 0) {
      return String(fileResults[0].values[0][0]);
    }

    const symbolResults = db.exec(
      "SELECT f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ? AND f.role = 'test'",
      [nodeId],
    );
    if (symbolResults.length > 0 && symbolResults[0].values.length > 0) {
      return String(symbolResults[0].values[0][0]);
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
          confidence: 0.75,
        });
      }
    } catch {
      // skip
    }
  }

  return tests;
}

function findTestsByPathTokenOverlap(db: SqlJsDatabase, target: string): TestInfo[] {
  const targetTokens = tokenizePathForTestMatching(target);
  if (targetTokens.size === 0) return [];

  try {
    const rows = db.exec("SELECT path FROM files WHERE role = 'test' LIMIT 500")[0]?.values ?? [];
    return rows
      .map((row) => {
        const filePath = String(row[0]);
        const testTokens = tokenizePathForTestMatching(filePath);
        const overlap = [...targetTokens].filter((token) => testTokens.has(token));
        return { filePath, overlap };
      })
      .filter((item) => item.overlap.length > 0)
      .sort((a, b) => b.overlap.length - a.overlap.length || a.filePath.localeCompare(b.filePath))
      .slice(0, 5)
      .map((item) => ({
        filePath: item.filePath,
        method: "path token overlap",
        details: "Shares path tokens with target: " + item.overlap.join(", "),
        confidence: Math.min(0.7, 0.45 + item.overlap.length * 0.1),
      }));
  } catch {
    return [];
  }
}

function buildRelatedTestEvidence(db: SqlJsDatabase, tests: TestInfo[]): {
  allowedNextReads: Array<{ path: string; lineRange?: string; reason: string; readPriority: "high" | "medium" | "low"; maxLines: string }>;
  exactSnippets: Array<{ path: string; startLine: number; endLine: number; code: string; whyIncluded: string }>;
  evidence: Array<{ file: string; line: number; endLine: number; confidence: number; provenance: "parser" | "resolver" | "heuristic"; preview: string | null }>;
} {
  const exactSnippets = tests
    .map((test) => {
      const chunk = getFirstChunkForFile(db, test.filePath);
      if (!chunk) return null;
      return {
        path: test.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        code: chunk.content,
        whyIncluded: test.details,
      };
    })
    .filter((snippet): snippet is { path: string; startLine: number; endLine: number; code: string; whyIncluded: string } => Boolean(snippet));

  const evidence = tests.map((test) => {
    const snippet = exactSnippets.find((item) => item.path === test.filePath);
    return {
      file: test.filePath,
      line: snippet?.startLine ?? 1,
      endLine: snippet?.endLine ?? snippet?.startLine ?? 1,
      confidence: test.confidence ?? 0.7,
      provenance: test.method.includes("graph") || test.method.includes("naming")
        ? "resolver" as const
        : "heuristic" as const,
      preview: snippet?.code.slice(0, 240) ?? null,
    };
  });

  return {
    allowedNextReads: tests.map((test) => {
      const snippet = exactSnippets.find((item) => item.path === test.filePath);
      return {
        path: test.filePath,
        ...(snippet ? { lineRange: snippet.startLine + "-" + snippet.endLine } : {}),
        reason: test.details,
        readPriority: "medium" as const,
        maxLines: snippet ? snippet.startLine + "-" + snippet.endLine : "targeted test read only",
      };
    }),
    exactSnippets,
    evidence,
  };
}

function getFirstChunkForFile(db: SqlJsDatabase, filePath: string): { startLine: number; endLine: number; content: string } | null {
  try {
    const rows = db.exec(
      `SELECT c.start_line, c.end_line, c.content
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE f.path = ?
       ORDER BY c.start_line ASC
       LIMIT 1`,
      [filePath],
    )[0]?.values ?? [];
    if (rows.length === 0) return null;
    return {
      startLine: Number(rows[0][0]),
      endLine: Number(rows[0][1]),
      content: String(rows[0][2]),
    };
  } catch {
    return null;
  }
}

function tokenizePathForTestMatching(value: string): Set<string> {
  const stop = new Set(["src", "lib", "test", "tests", "__tests__", "spec", "e2e", "unit", "module", "index", "js", "jsx", "ts", "tsx", "py"]);
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.endsWith("s") ? token.slice(0, -1) : token)
      .filter((token) => token.length > 2 && !stop.has(token)),
  );
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
