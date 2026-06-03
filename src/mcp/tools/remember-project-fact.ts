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
import type { MemoryType, InvalidationRule } from "../../shared/types.js";
import { withRepoDatabase } from "../repo-router.js";

const log = createLogger("mcp:remember-project-fact");

const MEMORY_TYPES = ["repo", "session", "branch", "decision", "user_preference"] as const;

export function registerRememberProjectFactTool(server: McpServer, db: SqlJsDatabase): void {
  server.tool(
    "remember_project_fact",
    "Save a project memory or fact for future reference. " +
    "Supports types: repo (general knowledge), decision (architectural decision), " +
    "user_preference (user-specific preference), session (current session context), " +
    "branch (branch-specific knowledge). Use this to persist important findings. " +
    "When scope is provided, auto-invalidation rules are generated automatically.",
    {
      content: z.string().describe("The content of the memory/fact to save"),
      type: z.enum(MEMORY_TYPES).describe("Type of memory").default("repo"),
      scope: z.array(z.string()).describe("File paths or names this memory relates to").optional().default([]),
      confidence: z.number().describe("Confidence level (0.0-1.0, default 1.0)").optional().default(1.0),
      evidence: z.array(z.string()).describe("Evidence file paths supporting this fact").optional().default([]),
      invalidateOn: z.array(z.object({
        type: z.enum(["commit", "file_change", "symbol_change", "time"]),
        target: z.string(),
        description: z.string().optional(),
      })).describe("Auto-invalidation rules — when these conditions are met, the memory is marked stale").optional().default([]),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ content, type, scope, confidence, evidence, invalidateOn, repo }) => {
      try {
        return await withRepoDatabase(repo, db, async (activeDb, _projectRoot) => {
          if (!content.trim()) {
            return {
              content: [{ type: "text" as const, text: "Error: Content cannot be empty." }],
              isError: true,
            };
          }

          // Smart fallback: if scope is provided but no invalidation rules, auto-inject file_change rules
          const processedRules: InvalidationRule[] = (invalidateOn || []).map(r => ({
            type: r.type,
            target: r.target,
            description: r.description || `${r.type} rule for ${r.target}`,
          }));
          if (scope && scope.length > 0) {
            for (const scopedPath of scope) {
              const hasChangeRule = processedRules.some(r => r.type === 'file_change' && r.target === scopedPath);
              if (!hasChangeRule) {
                processedRules.push({ type: 'file_change', target: scopedPath, description: `Auto-generated: invalidate when ${scopedPath} changes` });
              }
            }
          }

          // If no evidence provided but scope exists, use first scope path as evidence
          const processedEvidence = (evidence && evidence.length > 0)
            ? evidence
            : (scope && scope.length > 0 ? [scope[0]] : []);

          const now = new Date().toISOString();
          const id = nanoid();

          createMemory({
            id,
            type: type as MemoryType,
            content: content.trim(),
            scope,
            evidence: processedEvidence,
            confidence: Math.min(Math.max(confidence, 0), 1),
            createdCommit: null,
            lastValidatedCommit: null,
            invalidationRules: processedRules,
            createdAt: now,
            updatedAt: now,
          });

          log.info("Saved memory: " + id + " (type: " + type + ", rules: " + processedRules.length + ")");

          return {
            content: [{
              type: "text" as const,
              text: "Memory saved successfully.\n" +
                "ID: " + id + "\n" +
                "Type: " + type + "\n" +
                "Content: " + content.trim() + "\n" +
                "Scope: " + (scope?.join(', ') || 'none') + "\n" +
                "Evidence: " + (processedEvidence.join(', ') || 'none') + "\n" +
                "Auto-invalidation rules: " + processedRules.length + " rule(s)\n" +
                "Confidence: " + confidence.toFixed(1) + "\n" +
                "Saved at: " + now,
            }],
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
