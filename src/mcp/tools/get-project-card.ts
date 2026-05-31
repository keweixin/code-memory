/**
 * MCP Tool: get_project_card
 *
 * Returns a project identity card containing metadata about the
 * currently indexed codebase: project name, languages, file/symbol
 * counts, architecture style, framework, and index status.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:get-project-card");

export function registerGetProjectCardTool(server: McpServer, _db: SqlJsDatabase): void {
  server.tool(
    "get_project_card",
    "Get the project identity card: name, languages, file counts, " +
    "symbol counts, architecture style, framework, and index status. " +
    "Use this to orient yourself when starting work in a project.",
    {},
    async () => {
      try {
        const meta = getIndexMetadata(_db);
        const stats = getDatabaseStats(_db);

        const card = {
          ...meta,
          ...stats,
        };

        const text = formatProjectCard(card);
        log.info("Returned project card");

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to get project card: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: Failed to get project card - ${msg}` }],
          isError: true,
        };
      }
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────

interface ProjectCardRaw {
  name: string;
  languages: string;
  architecture_style: string | null;
  framework: string | null;
  root_path: string;
  current_commit: string | null;
  current_branch: string | null;
  total_files: number;
  indexed_files: number;
  total_symbols: number;
  total_edges: number;
  total_chunks: number;
  total_memories: number;
  last_full_index: string | null;
  index_completed: string | null;
  embedding_provider: string | null;
  embedding_model: string | null;
  vector_search: string | null;
}

function getIndexMetadata(db: SqlJsDatabase): ProjectCardRaw {
  const defaultCard: ProjectCardRaw = {
    name: "Unknown",
    languages: "",
    architecture_style: null,
    framework: null,
    root_path: "",
    current_commit: null,
    current_branch: null,
    total_files: 0,
    indexed_files: 0,
    total_symbols: 0,
    total_edges: 0,
    total_chunks: 0,
    total_memories: 0,
    last_full_index: null,
    index_completed: null,
    embedding_provider: null,
    embedding_model: null,
    vector_search: null,
  };

  try {
    const results = db.exec(
      "SELECT key, value FROM index_metadata"
    );
    if (!results.length || !results[0].values.length) return defaultCard;

    for (const row of results[0].values) {
      const key = String(row[0]);
      const value = String(row[1]);
      switch (key) {
        case "project_name": defaultCard.name = value; break;
        case "languages": defaultCard.languages = value; break;
        case "architecture_style": defaultCard.architecture_style = value; break;
        case "framework": defaultCard.framework = value; break;
        case "root_path": defaultCard.root_path = value; break;
        case "current_commit": defaultCard.current_commit = value; break;
        case "current_branch": defaultCard.current_branch = value; break;
        case "total_files": defaultCard.total_files = parseInt(value, 10) || 0; break;
        case "total_symbols": defaultCard.total_symbols = parseInt(value, 10) || 0; break;
        case "last_full_index": defaultCard.last_full_index = value; break;
        case "index_completed": defaultCard.index_completed = value; break;
        case "embedding_provider": defaultCard.embedding_provider = value; break;
        case "embedding_model": defaultCard.embedding_model = value; break;
        case "vector_search": defaultCard.vector_search = value; break;
      }
    }
  } catch {
    // return defaults
  }

  return defaultCard;
}

function getDatabaseStats(db: SqlJsDatabase): Record<string, number> {
  const stats: Record<string, number> = {
    actual_files: 0,
    actual_symbols: 0,
    actual_edges: 0,
    actual_chunks: 0,
    actual_memories: 0,
  };

  const queries: [string, string][] = [
    ["actual_files", "SELECT COUNT(*) as cnt FROM files"],
    ["actual_symbols", "SELECT COUNT(*) as cnt FROM symbols"],
    ["actual_edges", "SELECT COUNT(*) as cnt FROM edges"],
    ["actual_chunks", "SELECT COUNT(*) as cnt FROM chunks"],
    ["actual_memories", "SELECT COUNT(*) as cnt FROM memories"],
  ];

  for (const [key, sql] of queries) {
    try {
      const result = db.exec(sql);
      if (result.length > 0 && result[0].values.length > 0) {
        stats[key] = Number(result[0].values[0][0]);
      }
    } catch {
      // keep 0
    }
  }

  return stats;
}

function formatProjectCard(card: Record<string, unknown>): string {
  const lines: string[] = [];

  lines.push("=== Project Identity Card ===");
  lines.push("");
  lines.push(`Name:       ${card.name}`);
  lines.push(`Root Path:  ${card.root_path || "(not set)"}`);

  if (card.languages) {
    const langs = String(card.languages).split(",").filter(Boolean).join(", ");
    lines.push(`Languages:  ${langs}`);
  }
  if (card.architecture_style) {
    lines.push(`Architecture: ${card.architecture_style}`);
  }
  if (card.framework) {
    lines.push(`Framework:  ${card.framework}`);
  }

  lines.push("");
  lines.push("=== Index Status ===");
  lines.push(`Files:      ${card.actual_files} (${card.total_files} tracked)`);
  lines.push(`Symbols:    ${card.actual_symbols}`);
  lines.push(`Edges:      ${card.actual_edges}`);
  lines.push(`Chunks:     ${card.actual_chunks}`);
  lines.push(`Memories:   ${card.actual_memories}`);

  if (card.current_branch) {
    lines.push(`Branch:     ${card.current_branch}`);
  }
  if (card.current_commit) {
    lines.push(`Commit:     ${card.current_commit}`);
  }
  if (card.last_full_index) {
    lines.push(`Last Index: ${card.last_full_index}`);
  }
  if (card.index_completed) {
    lines.push(`Index Completed: ${card.index_completed}`);
  }

  const embeddingProvider = String(card.embedding_provider || "none");
  const embeddingModel = String(card.embedding_model || "none");
  const vectorStatus = card.vector_search === "enabled"
    ? "enabled"
    : embeddingProvider !== "none" ? "pending index" : "disabled";
  lines.push(`Embedding:  ${embeddingProvider} (${embeddingModel})`);
  lines.push(`Vector:     ${vectorStatus}`);

  return lines.join("\n");
}
