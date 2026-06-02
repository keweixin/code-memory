/**
 * MCP Tool: get_repo_map
 *
 * Returns a hierarchical map of the repository file structure,
 * including file roles, languages, and exported symbols.
 * Results are trimmed to fit within a token budget.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { createLogger } from "../../shared/logger.js";
import { estimateTokens } from "../../shared/token-counter.js";
import { withRepoDatabase } from "../repo-router.js";

const log = createLogger("mcp:get-repo-map");

export function registerGetRepoMapTool(server: McpServer, _db: SqlJsDatabase): void {
  server.tool(
    "get_repo_map",
    "Get a hierarchical map of the repository file structure. " +
    "Shows directories, files with their roles and languages, and top-level exports. " +
    "Respects a token budget to avoid overwhelming context. " +
    "Use this to understand the overall project layout.",
    {
      tokenBudget: z
        .number()
        .describe("Maximum tokens to use for the output (default 2000)")
        .optional()
        .default(2000),
      directory: z
        .string()
        .describe("Focus on a specific directory (e.g. 'src/'). Empty for root")
        .optional()
        .default(""),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ tokenBudget, directory, repo }) => {
      try {
        const mapText = await withRepoDatabase(repo, _db, async (activeDb) =>
          buildRepoMap(activeDb, tokenBudget, directory),
        );
        log.info(`Returned repo map (budget: ${tokenBudget}, dir: "${directory}")`);

        return {
          content: [{ type: "text" as const, text: mapText }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to get repo map: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: Failed to get repo map - ${msg}` }],
          isError: true,
        };
      }
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────

interface FileEntry {
  fileId: string;
  path: string;
  role: string;
  language: string;
  size: number;
  exports: string;
  symbols: SymbolEntry[];
}

interface SymbolEntry {
  name: string;
  kind: string;
  startLine: number;
}

interface DirNode {
  name: string;
  files: FileEntry[];
  children: Map<string, DirNode>;
}

function buildRepoMap(db: SqlJsDatabase, tokenBudget: number, directory: string): string {
  // Fetch all files
  let sql = "SELECT id, path, role, language, size, exports FROM files WHERE is_ignored = 0";
  const params: string[] = [];

  if (directory) {
    sql += " AND path LIKE ?";
    params.push(`${directory.replace(/\/$/, "")}/%`);
  }

  sql += " ORDER BY path";

  const results = db.exec(sql, params);
  if (!results.length || !results[0].values.length) {
    return "=== Repository Map ===\n\n(no files indexed)\n\nTip: Run 'code-memory index' to scan and index your codebase.";
  }
  const symbolsByPath = getSymbolsByPath(db, directory);

  // Build directory tree
  const root: DirNode = { name: directory || "/", files: [], children: new Map() };

  for (const row of results[0].values) {
    const fileId = String(row[0]);
    const path = String(row[1]);
    const entry: FileEntry = {
      fileId,
      path,
      role: String(row[2]),
      language: String(row[3]),
      size: Number(row[4]),
      exports: String(row[5]),
      symbols: symbolsByPath.get(path) || [],
    };

    insertIntoTree(root, entry, directory);
  }

  // Format as text with token budget
  const communitiesByFile = getCommunitiesByFileId(db);
  if (communitiesByFile.size === 0) {
    return formatTree(root, tokenBudget);
  }
  return formatTreeByCommunity(root, tokenBudget, communitiesByFile);
}

function getCommunitiesByFileId(db: SqlJsDatabase): Map<string, { name: string; cohesion: number }> {
  const map = new Map<string, { name: string; cohesion: number }>();
  try {
    const rows = db.all<{ file_id: string; name: string; cohesion: number }>(
      `SELECT cm.file_id, c.name AS name, c.cohesion AS cohesion
       FROM community_members cm
       JOIN communities c ON c.id = cm.community_id
       WHERE cm.file_id IS NOT NULL`,
    );
    for (const row of rows) {
      if (!map.has(row.file_id)) {
        map.set(row.file_id, { name: row.name, cohesion: row.cohesion });
      }
    }
  } catch {
    // communities tables may not exist yet; fall back to plain tree.
  }
  return map;
}

function collectAllFiles(node: DirNode): FileEntry[] {
  const files: FileEntry[] = [];
  for (const file of node.files) files.push(file);
  for (const child of node.children.values()) files.push(...collectAllFiles(child));
  return files;
}

function formatTreeByCommunity(
  root: DirNode,
  maxTokens: number,
  communitiesByFile: Map<string, { name: string; cohesion: number }>,
): string {
  const lines: string[] = [];
  let tokensUsed = 0;

  const header = "=== Repository Map (grouped by community) ===\n";
  tokensUsed += estimateTokens(header);
  lines.push(header);

  const allFiles = collectAllFiles(root);
  const grouped = new Map<string, FileEntry[]>();
  const unassigned: FileEntry[] = [];
  for (const file of allFiles) {
    const community = file.fileId ? communitiesByFile.get(file.fileId) : undefined;
    if (community) {
      const list = grouped.get(community.name) ?? [];
      list.push(file);
      grouped.set(community.name, list);
    } else {
      unassigned.push(file);
    }
  }

  const communityNames = [...grouped.keys()].sort((a, b) => {
    const aSize = grouped.get(a)!.length;
    const bSize = grouped.get(b)!.length;
    if (aSize !== bSize) return bSize - aSize;
    return a.localeCompare(b);
  });

  for (const name of communityNames) {
    if (tokensUsed >= maxTokens) {
      lines.push("... (more communities, truncated by token budget)");
      break;
    }
    const files = grouped.get(name)!;
    const cohesion = files[0]?.fileId ? communitiesByFile.get(files[0].fileId)?.cohesion ?? 0 : 0;
    const sectionHeader = `[community: ${name} (cohesion: ${cohesion.toFixed(2)})] — ${files.length} file(s)`;
    const sectionHeaderTokens = estimateTokens(sectionHeader + "\n");
    if (tokensUsed + sectionHeaderTokens > maxTokens) {
      lines.push("... (community section truncated by token budget)");
      break;
    }
    lines.push(sectionHeader);
    tokensUsed += sectionHeaderTokens;

    const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sortedFiles) {
      if (tokensUsed >= maxTokens) {
        lines.push("  ... (more files in this community, truncated by token budget)");
        break;
      }
      const fileLine = formatFileLine(file, "  ");
      const lineTokens = estimateTokens(fileLine + "\n");
      if (tokensUsed + lineTokens > maxTokens) {
        lines.push("  ... (more files in this community, truncated by token budget)");
        break;
      }
      lines.push(fileLine);
      tokensUsed += lineTokens;
    }
    lines.push("");
    tokensUsed += estimateTokens("\n");
  }

  if (unassigned.length > 0) {
    if (tokensUsed < maxTokens) {
      const header2 = "[no community]";
      const header2Tokens = estimateTokens(header2 + "\n");
      if (tokensUsed + header2Tokens <= maxTokens) {
        lines.push(header2);
        tokensUsed += header2Tokens;
        const sortedUnassigned = [...unassigned].sort((a, b) => a.path.localeCompare(b.path));
        for (const file of sortedUnassigned) {
          if (tokensUsed >= maxTokens) {
            lines.push("  ... (more files, truncated by token budget)");
            break;
          }
          const fileLine = formatFileLine(file, "  ");
          const lineTokens = estimateTokens(fileLine + "\n");
          if (tokensUsed + lineTokens > maxTokens) {
            lines.push("  ... (more files, truncated by token budget)");
            break;
          }
          lines.push(fileLine);
          tokensUsed += lineTokens;
        }
        lines.push("");
        tokensUsed += estimateTokens("\n");
      }
    }
  }

  return lines.join("\n");
}

function formatFileLine(file: FileEntry, indent: string): string {
  const fileName = file.path.split("/").pop() || file.path;
  const symbolStr = formatSymbols(file.symbols);
  const exportStr = symbolStr || formatExports(file.exports);
  return `${indent}${fileName} [${file.role}] [${file.language}]${exportStr}`;
}

function insertIntoTree(root: DirNode, entry: FileEntry, baseDir: string): void {
  const relativePath = baseDir
    ? entry.path.replace(baseDir + "/", "")
    : entry.path;

  const parts = relativePath.split("/");
  parts.pop();
  let current = root;

  for (const part of parts) {
    if (!current.children.has(part)) {
      current.children.set(part, { name: part, files: [], children: new Map() });
    }
    current = current.children.get(part)!;
  }

  current.files.push(entry);
}

function formatTree(node: DirNode, maxTokens: number, depth: number = 0): string {
  const lines: string[] = [];
  let tokensUsed = 0;

  // Root header
  if (depth === 0) {
    const header = `=== Repository Map ===\n`;
    tokensUsed += estimateTokens(header);
    lines.push(header);
  }

  const indent = "  ".repeat(depth);
  if (depth > 0) {
    const dirLine = `${indent}${node.name}/`;
    lines.push(dirLine);
    tokensUsed += estimateTokens(dirLine + "\n");
  }

  // Files in this directory
  const sortedFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const fileName = file.path.split("/").pop() || file.path;

    const symbolStr = formatSymbols(file.symbols);
    const exportStr = symbolStr || formatExports(file.exports);

    const fileLine = `${indent}  ${fileName} [${file.role}] [${file.language}]${exportStr}`;
    const lineTokens = estimateTokens(fileLine + "\n");

    if (tokensUsed + lineTokens > maxTokens) {
      lines.push(`${indent}  ... (${sortedFiles.length - lines.length + depth} more files, truncated by token budget)`);
      return lines.join("\n");
    }

    lines.push(fileLine);
    tokensUsed += lineTokens;
  }

  // Subdirectories
  const sortedDirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));

  for (const child of sortedDirs) {
    if (tokensUsed >= maxTokens) {
      lines.push(`${indent}... (more directories, truncated by token budget)`);
      break;
    }
    const remaining = maxTokens - tokensUsed;
    const childLines = formatTree(child, remaining, depth + 1);
    lines.push(childLines);
    tokensUsed += estimateTokens(childLines);
  }

  return lines.join("\n");
}

function getSymbolsByPath(db: SqlJsDatabase, directory: string): Map<string, SymbolEntry[]> {
  const params: string[] = [];
  let sql = `
    SELECT f.path, s.name, s.kind, s.start_line
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE f.is_ignored = 0`;

  if (directory) {
    sql += " AND f.path LIKE ?";
    params.push(`${directory.replace(/\/$/, "")}/%`);
  }

  sql += " ORDER BY f.path, s.start_line, s.start_column";

  const results = db.exec(sql, params);
  const byPath = new Map<string, SymbolEntry[]>();
  if (!results.length) return byPath;

  for (const row of results[0].values) {
    const path = String(row[0]);
    const current = byPath.get(path) || [];
    current.push({
      name: String(row[1]),
      kind: String(row[2]),
      startLine: Number(row[3]),
    });
    byPath.set(path, current);
  }
  return byPath;
}

function formatSymbols(symbols: SymbolEntry[]): string {
  if (symbols.length === 0) return "";
  const display = symbols.slice(0, 8).map((symbol) => `${symbol.name}:${symbol.kind}`);
  const suffix = symbols.length > 8 ? ", ..." : "";
  return ` symbols: {${display.join(", ")}${suffix}}`;
}

function formatExports(exportsJson: string): string {
  try {
    const exports = JSON.parse(exportsJson) as string[];
    if (Array.isArray(exports) && exports.length > 0) {
      const display = exports.slice(0, 5);
      const suffix = exports.length > 5 ? ", ..." : "";
      return ` exports: {${display.join(", ")}${suffix}}`;
    }
  } catch {
    // ignore parse errors
  }
  return "";
}
