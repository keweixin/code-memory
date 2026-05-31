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
    },
    async ({ tokenBudget, directory }) => {
      try {
        const mapText = buildRepoMap(_db, tokenBudget, directory);
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
  path: string;
  role: string;
  language: string;
  size: number;
  exports: string;
}

interface DirNode {
  name: string;
  files: FileEntry[];
  children: Map<string, DirNode>;
}

function buildRepoMap(db: SqlJsDatabase, tokenBudget: number, directory: string): string {
  // Fetch all files
  let sql = "SELECT path, role, language, size, exports FROM files WHERE is_ignored = 0";
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

  // Build directory tree
  const root: DirNode = { name: directory || "/", files: [], children: new Map() };

  for (const row of results[0].values) {
    const path = String(row[0]);
    const entry: FileEntry = {
      path,
      role: String(row[1]),
      language: String(row[2]),
      size: Number(row[3]),
      exports: String(row[4]),
    };

    insertIntoTree(root, entry, directory);
  }

  // Format as text with token budget
  return formatTree(root, tokenBudget);
}

function insertIntoTree(root: DirNode, entry: FileEntry, baseDir: string): void {
  const relativePath = baseDir
    ? entry.path.replace(baseDir + "/", "")
    : entry.path;

  const parts = relativePath.split("/");
  const fileName = parts.pop()!;
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

    // Parse exports to show top-level symbols
    const exportStr = formatExports(file.exports);

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
