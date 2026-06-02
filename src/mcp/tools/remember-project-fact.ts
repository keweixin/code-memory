/**
 * MCP Tool: remember_project_fact
 *
 * Saves a project memory (fact, decision, user preference)
 * into the memory repository for persistent cross-session recall.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { SqlJsDatabase } from "../../storage/database.js";
import { createMemory } from "../../storage/memory-repository.js";
import { createLogger } from "../../shared/logger.js";
import type { MemoryType } from "../../shared/types.js";

const log = createLogger("mcp:remember-project-fact");

const MEMORY_TYPES = ["repo", "session", "branch", "decision", "user_preference"] as const;

export function registerRememberProjectFactTool(server: McpServer, _db: SqlJsDatabase): void {
  server.tool(
    "remember_project_fact",
    "Save a project memory or fact for future reference. " +
    "Supports types: repo (general knowledge), decision (architectural decision), " +
    "user_preference (user-specific preference), session (current session context), " +
    "branch (branch-specific knowledge). Use this to persist important findings.",
    {
      content: z.string().describe("The content of the memory/fact to save"),
      type: z.enum(MEMORY_TYPES).describe("Type of memory").default("repo"),
      scope: z.array(z.string()).describe("File paths or names this memory relates to").optional().default([]),
      confidence: z.number().describe("Confidence level (0.0-1.0, default 1.0)").optional().default(1.0),
    },
    async ({ content, type, scope, confidence }) => {
      try {
        if (!content.trim()) {
          return {
            content: [{ type: "text" as const, text: "Error: Content cannot be empty." }],
            isError: true,
          };
        }

        const now = new Date().toISOString();
        const id = nanoid();

        createMemory({
          id,
          type: type as MemoryType,
          content: content.trim(),
          scope,
          evidence: [],
          confidence: Math.min(Math.max(confidence, 0), 1),
          createdCommit: null,
          lastValidatedCommit: null,
          invalidationRules: [],
          createdAt: now,
          updatedAt: now,
        });

        log.info("Saved memory: " + id + " (type: " + type + ")");

        return {
          content: [{
            type: "text" as const,
            text: "Memory saved successfully.\n" +
              "ID: " + id + "\n" +
              "Type: " + type + "\n" +
              "Content: " + content.trim() + "\n" +
              "Confidence: " + confidence.toFixed(1) + "\n" +
              "Saved at: " + now,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Remember project fact failed: " + msg);
        return {
          content: [{ type: "text" as const, text: "Error: Remember project fact failed - " + msg }],
          isError: true,
        };
      }
    },
  );
}
