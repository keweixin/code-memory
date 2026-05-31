/**
 * MCP Tool: explain_module
 *
 * Explains a module's structure: symbols, imports, exports,
 * dependencies, and key characteristics. Provides a comprehensive
 * overview of a file's role in the codebase.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:explain-module");

export function registerExplainModuleTool(server: McpServer, db: SqlJsDatabase): void {
  server.tool(
    "explain_module",
    "Explain a module's structure and role in the codebase. " +
    "Returns symbols, imports, exports, dependencies, and key " +
    "characteristics. Use this to quickly understand what a file does.",
    {
      filePath: z.string().describe("The file path to explain"),
    },
    async ({ filePath }) => {
      try {
        const fileInfo = getFileInfo(db, filePath);
        if (!fileInfo) {
          return {
            content: [{
              type: "text" as const,
              text: "File not found in index: " + filePath + ". Ensure it has been indexed.",
            }],
          };
        }

        const symbols = getFileSymbols(db, fileInfo.id);
        const dependencies = getFileDependencies(db, fileInfo.id);
        const dependents = getFileDependents(db, fileInfo.id);
        const chunks = getFileChunks(db, fileInfo.id);
        const memories = getFileMemories(db, filePath);

        const text = formatModuleExplanation(fileInfo, symbols, dependencies, dependents, chunks, memories);
        log.info("Explained module: " + filePath + " (" + symbols.length + " symbols)");

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Explain module failed: " + msg);
        return {
          content: [{ type: "text" as const, text: "Error: Explain module failed - " + msg }],
          isError: true,
        };
      }
    },
  );
}

// ---- Data Access ----

interface FileInfo {
  id: string;
  path: string;
  language: string;
  role: string;
  size: number;
  riskLevel: string;
  isGenerated: boolean;
  summary: string | null;
  exports: string[];
  imports: Array<{ source: string; names: string[] }>;
}

interface SymbolInfo {
  id: string;
  name: string;
  kind: string;
  signature: string | null;
  summary: string | null;
  accessLevel: string | null;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

interface DepInfo {
  path: string;
  type: string;
  confidence: number;
}

function getFileInfo(db: SqlJsDatabase, path: string): FileInfo | null {
  try {
    const results = db.exec(
      "SELECT id, path, language, role, size, risk_level, is_generated, summary, exports, imports " +
      "FROM files WHERE path = ?",
      [path],
    );
    if (results.length > 0 && results[0].values.length > 0) {
      const row = results[0].values[0];
      return {
        id: String(row[0]),
        path: String(row[1]),
        language: String(row[2]),
        role: String(row[3]),
        size: Number(row[4]),
        riskLevel: String(row[5]),
        isGenerated: Boolean(row[6]),
        summary: row[7] ? String(row[7]) : null,
        exports: parseJsonArray(String(row[8])),
        imports: parseImports(String(row[9])),
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function getFileSymbols(db: SqlJsDatabase, fileId: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  try {
    const results = db.exec(
      "SELECT id, name, kind, signature, summary, access_level, " +
      "start_line, end_line, start_column, end_column " +
      "FROM symbols WHERE file_id = ? ORDER BY start_line, start_column",
      [fileId],
    );
    if (results.length > 0) {
      for (const row of results[0].values) {
        symbols.push({
          id: String(row[0]),
          name: String(row[1]),
          kind: String(row[2]),
          signature: row[3] ? String(row[3]) : null,
          summary: row[4] ? String(row[4]) : null,
          accessLevel: row[5] ? String(row[5]) : null,
          startLine: Number(row[6]),
          endLine: Number(row[7]),
          startColumn: Number(row[8]),
          endColumn: Number(row[9]),
        });
      }
    }
  } catch {
    // fall through
  }
  return symbols;
}

function getFileDependencies(db: SqlJsDatabase, fileId: string): DepInfo[] {
  const deps: DepInfo[] = [];
  try {
    const results = db.exec(
      "SELECT f.path, e.type, e.confidence FROM edges e " +
      "JOIN files f ON e.to_id = f.id " +
      "WHERE e.from_id = ? AND e.type IN ('IMPORTS', 'CALLS') LIMIT 30",
      [fileId],
    );
    if (results.length > 0) {
      for (const row of results[0].values) {
        deps.push({
          path: String(row[0]),
          type: String(row[1]),
          confidence: Number(row[2]),
        });
      }
    }
  } catch {
    // fall through
  }
  return deps;
}

function getFileDependents(db: SqlJsDatabase, fileId: string): DepInfo[] {
  const deps: DepInfo[] = [];
  try {
    const results = db.exec(
      "SELECT f.path, e.type, e.confidence FROM edges e " +
      "JOIN files f ON e.from_id = f.id " +
      "WHERE e.to_id = ? AND e.type IN ('IMPORTS', 'CALLS', 'TESTS') LIMIT 30",
      [fileId],
    );
    if (results.length > 0) {
      for (const row of results[0].values) {
        deps.push({
          path: String(row[0]),
          type: String(row[1]),
          confidence: Number(row[2]),
        });
      }
    }
  } catch {
    // fall through
  }
  return deps;
}

function getFileChunks(db: SqlJsDatabase, fileId: string): Array<{ content: string; summary: string | null }> {
  const chunks: Array<{ content: string; summary: string | null }> = [];
  try {
    const results = db.exec(
      "SELECT content, summary FROM chunks WHERE file_id = ? LIMIT 5",
      [fileId],
    );
    if (results.length > 0) {
      for (const row of results[0].values) {
        chunks.push({
          content: String(row[0]),
          summary: row[1] ? String(row[1]) : null,
        });
      }
    }
  } catch {
    // fall through
  }
  return chunks;
}

function getFileMemories(db: SqlJsDatabase, filePath: string): Array<{ content: string; confidence: number }> {
  const memories: Array<{ content: string; confidence: number }> = [];
  try {
    const scopePattern = "%\"" + filePath + "\"%";
    const results = db.exec(
      "SELECT content, confidence FROM memories WHERE scope LIKE ? LIMIT 10",
      [scopePattern],
    );
    if (results.length > 0) {
      for (const row of results[0].values) {
        memories.push({
          content: String(row[0]),
          confidence: Number(row[1]),
        });
      }
    }
  } catch {
    // fall through
  }
  return memories;
}

// ---- Helpers ----

function parseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseImports(json: string): Array<{ source: string; names: string[] }> {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.map(function(imp: { source?: string; names?: string[] }) {
        return {
          source: imp.source || "",
          names: Array.isArray(imp.names) ? imp.names : [],
        };
      });
    }
  } catch {
    // ignore
  }
  return [];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ---- Formatting ----

function formatModuleExplanation(
  fileInfo: FileInfo,
  symbols: SymbolInfo[],
  dependencies: DepInfo[],
  dependents: DepInfo[],
  chunks: Array<{ content: string; summary: string | null }>,
  memories: Array<{ content: string; confidence: number }>,
): string {
  const lines: string[] = [];

  lines.push("=== Module: " + fileInfo.path + " ===");
  lines.push("");
  lines.push("--- Overview ---");
  lines.push("Language:    " + fileInfo.language);
  lines.push("Role:        " + fileInfo.role);
  lines.push("Size:        " + formatFileSize(fileInfo.size));
  lines.push("Risk Level:  " + fileInfo.riskLevel);
  lines.push("Generated:   " + (fileInfo.isGenerated ? "Yes" : "No"));
  if (fileInfo.summary) {
    lines.push("Summary:     " + fileInfo.summary);
  }
  lines.push("");

  // Exports
  if (fileInfo.exports.length > 0) {
    lines.push("--- Exports (" + fileInfo.exports.length + ") ---");
    for (const exp of fileInfo.exports.slice(0, 20)) {
      lines.push("  - " + exp);
    }
    if (fileInfo.exports.length > 20) {
      lines.push("  ... and " + (fileInfo.exports.length - 20) + " more");
    }
    lines.push("");
  }

  // Imports
  if (fileInfo.imports.length > 0) {
    lines.push("--- Imports (" + fileInfo.imports.length + ") ---");
    for (const imp of fileInfo.imports.slice(0, 15)) {
      const names = imp.names.slice(0, 5).join(", ");
      const suffix = imp.names.length > 5 ? ", ..." : "";
      lines.push("  from \"" + imp.source + "\": " + names + suffix);
    }
    if (fileInfo.imports.length > 15) {
      lines.push("  ... and " + (fileInfo.imports.length - 15) + " more imports");
    }
    lines.push("");
  }

  // Symbols
  if (symbols.length > 0) {
    lines.push("--- Symbols (" + symbols.length + ") ---");
    const byKind: Record<string, number> = {};
    for (const sym of symbols) {
      byKind[sym.kind] = (byKind[sym.kind] || 0) + 1;
    }
    const kindSummary = Object.entries(byKind)
      .map(function(e) { return e[0] + ": " + e[1]; })
      .join(", ");
    lines.push("  By kind: " + kindSummary);
    lines.push("");

    for (const sym of symbols) {
      const access = sym.accessLevel ? " [" + sym.accessLevel + "]" : "";
      const sig = sym.signature ? ": " + sym.signature : "";
      const sum = sym.summary ? " -- " + sym.summary : "";
      lines.push("  " + formatSymbolLocation(fileInfo.path, sym) + ": " +
        sym.name + " (" + sym.kind + access + ")" + sig + sum);
    }
    lines.push("");
  }

  // Dependencies
  if (dependencies.length > 0) {
    lines.push("--- Dependencies (" + dependencies.length + ") ---");
    const seen = new Set<string>();
    for (const dep of dependencies) {
      const key = dep.path + ":" + dep.type;
      if (!seen.has(key)) {
        seen.add(key);
        lines.push("  [" + dep.type + "] " + dep.path + " (conf: " + dep.confidence.toFixed(1) + ")");
      }
    }
    lines.push("");
  }

  // Dependents
  if (dependents.length > 0) {
    lines.push("--- Depends On This (" + dependents.length + ") ---");
    const seen = new Set<string>();
    for (const dep of dependents) {
      const key = dep.path + ":" + dep.type;
      if (!seen.has(key)) {
        seen.add(key);
        const label = dep.type === "TESTS" ? " [TEST]" : "";
        lines.push("  [" + dep.type + "] " + dep.path + label + " (conf: " + dep.confidence.toFixed(1) + ")");
      }
    }
    lines.push("");
  }

  // Chunks / code preview
  if (chunks.length > 0) {
    lines.push("--- Code Preview ---");
    for (let i = 0; i < Math.min(chunks.length, 3); i++) {
      const ch = chunks[i];
      if (ch.summary) {
        lines.push("  // " + ch.summary);
      }
      const preview = ch.content.substring(0, 300);
      lines.push(preview);
      if (ch.content.length > 300) {
        lines.push("  ... (truncated)");
      }
      lines.push("");
    }
  }

  // Memories
  if (memories.length > 0) {
    lines.push("--- Related Memories (" + memories.length + ") ---");
    for (const mem of memories) {
      lines.push("  [" + mem.confidence.toFixed(1) + "] " + mem.content.substring(0, 120));
    }
    lines.push("");
  }

  lines.push("--- Summary ---");
  lines.push("This module is a " + fileInfo.role + " file in " + fileInfo.language +
    " with " + symbols.length + " symbols, " + fileInfo.exports.length + " exports, " +
    dependencies.length + " dependencies, and " + dependents.length + " dependents.");

  return lines.join("\n");
}

function formatSymbolLocation(filePath: string, sym: SymbolInfo): string {
  return filePath + ":" + sym.startLine + ":" + sym.startColumn +
    "-" + sym.endLine + ":" + sym.endColumn;
}
