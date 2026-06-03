/**
 * MCP Tool: invalidate_memory
 *
 * Invalidates (deletes or marks stale) a project memory.
 * Can target by ID or invalidate all memories of a given type.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import {
  getMemoryById,
  getMemoriesByType,
  deleteMemory,
} from "../../storage/memory-repository.js";
import { createLogger } from "../../shared/logger.js";
import type { MemoryType } from "../../shared/types.js";
import { withRepoDatabase } from "../repo-router.js";

const log = createLogger("mcp:invalidate-memory");

const MEMORY_TYPES = ["repo", "session", "branch", "decision", "user_preference"] as const;

export function registerInvalidateMemoryTool(server: McpServer, db: SqlJsDatabase): void {
  server.tool(
    "invalidate_memory",
    "Invalidate a stored project memory. You can delete by ID or " +
    "invalidate all memories of a specific type. Use this to remove " +
    "outdated or incorrect project knowledge.",
    {
      memoryId: z.string().describe("ID of the specific memory to invalidate").optional(),
      type: z.enum(MEMORY_TYPES).describe("Invalidate ALL memories of this type (use with caution)").optional(),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ memoryId, type, repo }) => {
      try {
        return await withRepoDatabase(repo, db, async (activeDb, _projectRoot) => {
          if (!memoryId && !type) {
            return {
              content: [{ type: "text" as const, text: "Error: Provide either memoryId or type to invalidate." }],
              isError: true,
            };
          }

          const results: string[] = [];

          if (memoryId) {
            const memory = getMemoryById(memoryId);
            if (!memory) {
              return {
                content: [{
                  type: "text" as const,
                  text: "No memory found with ID: " + memoryId + ".",
                }],
              };
            }
            deleteMemory(memoryId);
            results.push("Deleted memory: " + memoryId + " (type: " + memory.type + ", content: " +
              memory.content.substring(0, 80) + (memory.content.length > 80 ? "..." : "") + ")");
            log.info("Deleted memory: " + memoryId);
          }

          if (type) {
            const memories = getMemoriesByType(type as MemoryType);
            if (memories.length === 0) {
              results.push("No memories found of type: " + type);
            } else {
              for (const mem of memories) {
                deleteMemory(mem.id);
              }
              results.push("Deleted " + memories.length + " memories of type: " + type);
              log.info("Deleted " + memories.length + " memories of type: " + type);
            }
          }

          return {
            content: [{ type: "text" as const, text: "Invalidation complete:\n" + results.join("\n") }],
          };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: "Error: " + errorMsg }],
          isError: true,
        };
      }
    },
  );
}
