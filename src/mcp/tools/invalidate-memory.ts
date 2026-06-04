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
import { TOOL_CONTEXT_INPUT_SCHEMA } from "../tool-context.js";
import { errorToolResult, formatStructuredToolResult, toolResultFromProject } from "../tool-result.js";

const log = createLogger("mcp:invalidate-memory");

const MEMORY_TYPES = ["repo", "session", "branch", "decision", "user_preference"] as const;

export function registerInvalidateMemoryTool(server: McpServer, db?: SqlJsDatabase): void {
  server.tool(
    "invalidate_memory",
    "Invalidate a stored project memory. You can delete by ID or " +
    "invalidate all memories of a specific type. Use this to remove " +
    "outdated or incorrect project knowledge.",
    {
      memoryId: z.string().describe("ID of the specific memory to invalidate").optional(),
      type: z.enum(MEMORY_TYPES).describe("Invalidate ALL memories of this type (use with caution)").optional(),
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ memoryId, type, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, db, async (activeDb, projectRoot, resolution) => {
          if (!memoryId && !type) {
            return {
              content: [{
                type: "text" as const,
                text: formatStructuredToolResult(errorToolResult(
                  "Provide either memoryId or type to invalidate.",
                  { memoryId: memoryId ?? null, type: type ?? null },
                )),
              }],
              isError: true,
            };
          }

          const results: string[] = [];
          const deleted: Array<{ id: string; type: string; contentPreview: string }> = [];

          if (memoryId) {
            const memory = getMemoryById(memoryId, activeDb);
            if (!memory) {
              const display = "No memory found with ID: " + memoryId + ".";
              return {
                content: [{
                  type: "text" as const,
                  text: formatStructuredToolResult(toolResultFromProject(
                    projectRoot,
                    resolution.repoName ?? "",
                    activeDb,
                    {
                      memoryId,
                      type: type ?? null,
                      deletedCount: 0,
                      deleted,
                    },
                    display,
                    {
                      tool: "remember_project_fact",
                      reason: "No memory matched this ID. Use remember_project_fact to store corrected context if needed.",
                    },
                  )),
                }],
              };
            }
            deleteMemory(memoryId, activeDb);
            deleted.push({
              id: memoryId,
              type: memory.type,
              contentPreview: memory.content.substring(0, 80) + (memory.content.length > 80 ? "..." : ""),
            });
            results.push("Deleted memory: " + memoryId + " (type: " + memory.type + ", content: " +
              memory.content.substring(0, 80) + (memory.content.length > 80 ? "..." : "") + ")");
            log.info("Deleted memory: " + memoryId);
          }

          if (type) {
            const memories = getMemoriesByType(type as MemoryType, activeDb);
            if (memories.length === 0) {
              results.push("No memories found of type: " + type);
            } else {
              for (const mem of memories) {
                deleteMemory(mem.id, activeDb);
                deleted.push({
                  id: mem.id,
                  type: mem.type,
                  contentPreview: mem.content.substring(0, 80) + (mem.content.length > 80 ? "..." : ""),
                });
              }
              results.push("Deleted " + memories.length + " memories of type: " + type);
              log.info("Deleted " + memories.length + " memories of type: " + type);
            }
          }

          const display = "Invalidation complete:\n" + results.join("\n");
          return {
            content: [{
              type: "text" as const,
              text: formatStructuredToolResult(toolResultFromProject(
                projectRoot,
                resolution.repoName ?? "",
                activeDb,
                {
                  memoryId: memoryId ?? null,
                  type: type ?? null,
                  deletedCount: deleted.length,
                  deleted,
                  results,
                },
                display,
                {
                  tool: "remember_project_fact",
                  reason: "Use remember_project_fact to store replacement context if needed.",
                },
              )),
            }],
          };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: formatStructuredToolResult(errorToolResult(
              errorMsg,
              { memoryId: memoryId ?? null, type: type ?? null },
            )),
          }],
          isError: true,
        };
      }
    },
  );
}
