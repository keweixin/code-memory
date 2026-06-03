/**
 * MCP Tools: Context Ledger
 *
 * Session-level bookkeeping for context already returned to an agent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getContextDeltaForDb,
  getContextLedgerEntriesForDb,
  markContextUsed,
  compactSessionContext,
  resetContextSession,
  updateContextFeedback,
} from "../../memory/context-ledger.js";
import type { ContextFeedback } from "../../shared/types.js";
import { getDatabaseSync, isInitialized, type SqlJsDatabase } from "../../storage/database.js";
import { withRepoDatabase } from "../repo-router.js";

const FEEDBACK_VALUES = ["useful", "irrelevant", "stale"] as const;

export function registerContextLedgerTools(server: McpServer, db?: SqlJsDatabase): void {
  const routedDb = db ?? (isInitialized() ? getDatabaseSync() : undefined);

  server.tool(
    "mark_context_used",
    "Record files, symbols, chunks, token estimate, and evidence already returned to an agent session. " +
    "Use this after sending context so later retrieval can avoid repeated context.",
    {
      sessionId: z.string().describe("Stable ID for the agent/session/task"),
      taskId: z.string().optional().describe("Optional task ID shared across one multi-step job"),
      repoRoot: z.string().optional().describe("Repository root for this context entry"),
      branch: z.string().optional().describe("Git branch for this context entry"),
      commit: z.string().optional().describe("Git commit for this context entry"),
      query: z.string().describe("Task or query that caused this context to be returned"),
      returnedFiles: z.array(z.string()).optional().default([]),
      returnedSymbols: z.array(z.string()).optional().default([]),
      returnedChunks: z.array(z.string()).optional().default([]),
      tokenEstimate: z.number().optional().default(0),
      evidenceIds: z.array(z.string()).optional().default([]),
      evidenceFingerprints: z.array(z.string()).optional().default([]),
      noveltyScore: z.number().optional(),
      repeatedPenalty: z.number().optional(),
      agentFeedback: z.enum(FEEDBACK_VALUES).optional(),
      feedbackReason: z.string().optional(),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async (input) => {
      try {
        return await withRepoDatabase(input.repo, routedDb, async (activeDb, projectRoot) => {
          const id = markContextUsed({
            sessionId: input.sessionId,
            taskId: input.taskId,
            repoRoot: input.repoRoot || projectRoot,
            branch: input.branch,
            commit: input.commit,
            query: input.query,
            returnedFiles: input.returnedFiles,
            returnedSymbols: input.returnedSymbols,
            returnedChunks: input.returnedChunks,
            tokenEstimate: input.tokenEstimate,
            evidenceIds: input.evidenceIds,
            evidenceFingerprints: input.evidenceFingerprints,
            noveltyScore: input.noveltyScore,
            repeatedPenalty: input.repeatedPenalty,
            agentFeedback: input.agentFeedback as ContextFeedback | undefined,
            feedbackReason: input.feedbackReason,
          }, activeDb);
          return { content: [{ type: "text" as const, text: "Context ledger entry recorded: " + id }] };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory setup --project .\` for full AI onboarding, or \`code-memory bootstrap --project .\` for index-only initialization.`,
            }],
            isError: false,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_context_delta",
    "Compare candidate files, symbols, and chunks against context already returned in this session. " +
    "Use this before returning context to prefer new evidence over repeated context.",
    {
      sessionId: z.string().describe("Stable ID for the agent/session/task"),
      candidateFiles: z.array(z.string()).optional().default([]),
      candidateSymbols: z.array(z.string()).optional().default([]),
      candidateChunks: z.array(z.string()).optional().default([]),
      candidateEvidenceIds: z.array(z.string()).optional().default([]),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ sessionId, candidateFiles, candidateSymbols, candidateChunks, candidateEvidenceIds, repo }) => {
      try {
        return await withRepoDatabase(repo, routedDb, async (activeDb) => {
          const delta = getContextDeltaForDb(sessionId, {
            files: candidateFiles,
            symbols: candidateSymbols,
            chunks: candidateChunks,
            evidenceIds: candidateEvidenceIds,
          }, activeDb);
          return { content: [{ type: "text" as const, text: formatDelta(delta) }] };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory setup --project .\` for full AI onboarding, or \`code-memory bootstrap --project .\` for index-only initialization.`,
            }],
            isError: false,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "avoid_repeated_context",
    "Return a concise keep/drop recommendation for candidate context based on session ledger history.",
    {
      sessionId: z.string().describe("Stable ID for the agent/session/task"),
      candidateFiles: z.array(z.string()).optional().default([]),
      candidateSymbols: z.array(z.string()).optional().default([]),
      candidateChunks: z.array(z.string()).optional().default([]),
      candidateEvidenceIds: z.array(z.string()).optional().default([]),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ sessionId, candidateFiles, candidateSymbols, candidateChunks, candidateEvidenceIds, repo }) => {
      try {
        return await withRepoDatabase(repo, routedDb, async (activeDb) => {
          const delta = getContextDeltaForDb(sessionId, {
            files: candidateFiles,
            symbols: candidateSymbols,
            chunks: candidateChunks,
            evidenceIds: candidateEvidenceIds,
          }, activeDb);
          const lines = [
            "Context repetition check",
            "Prior tokens: " + delta.totalPriorTokens,
            "Keep files: " + formatList(delta.newFiles),
            "Drop repeated files: " + formatList(delta.repeatedFiles),
            "Keep symbols: " + formatList(delta.newSymbols),
            "Drop repeated symbols: " + formatList(delta.repeatedSymbols),
            "Keep chunks: " + formatList(delta.newChunks),
            "Drop repeated chunks: " + formatList(delta.repeatedChunks),
            "Keep evidence: " + formatList(delta.newEvidenceIds),
            "Drop repeated evidence: " + formatList(delta.repeatedEvidenceIds),
            "Novelty score: " + delta.noveltyScore.toFixed(2),
            "Repeated penalty: " + delta.repeatedPenalty.toFixed(2),
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory setup --project .\` for full AI onboarding, or \`code-memory bootstrap --project .\` for index-only initialization.`,
            }],
            isError: false,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "explain_why_this_context",
    "Explain whether a candidate context item is new or repeated for the session and show ledger evidence.",
    {
      sessionId: z.string().describe("Stable ID for the agent/session/task"),
      contextId: z.string().describe("File path, symbol name, or chunk ID to explain"),
      contextType: z.enum(["file", "symbol", "chunk"]).describe("Type of the contextId"),
      feedback: z.enum(FEEDBACK_VALUES).optional().describe("Optional feedback to apply to the latest ledger entry"),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ sessionId, contextId, contextType, feedback, repo }) => {
      try {
        return await withRepoDatabase(repo, routedDb, async (activeDb) => {
          let entries = getContextLedgerEntriesForDb(sessionId, activeDb);
          let seenIn = entries.filter((entry) => {
            if (contextType === "file") return entry.returnedFiles.includes(contextId);
            if (contextType === "symbol") return entry.returnedSymbols.includes(contextId);
            return entry.returnedChunks.includes(contextId);
          });
          if (feedback && seenIn.length > 0) {
            updateContextFeedback(seenIn[seenIn.length - 1].id, feedback as ContextFeedback, activeDb);
            entries = getContextLedgerEntriesForDb(sessionId, activeDb);
            seenIn = entries.filter((entry) => {
              if (contextType === "file") return entry.returnedFiles.includes(contextId);
              if (contextType === "symbol") return entry.returnedSymbols.includes(contextId);
              return entry.returnedChunks.includes(contextId);
            });
          }
          const lines = [
            contextId + " is " + (seenIn.length > 0 ? "repeated" : "new") + " for session " + sessionId,
            "Seen in entries: " + seenIn.length,
            "Prior tokens: " + entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0),
          ];
          for (const entry of seenIn.slice(-5)) {
            lines.push("- " + entry.createdAt + " query=\"" + entry.query + "\" feedback=" + (entry.agentFeedback || "none"));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory setup --project .\` for full AI onboarding, or \`code-memory bootstrap --project .\` for index-only initialization.`,
            }],
            isError: false,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "compact_session_context",
    "Summarize the context already returned in a session so the agent can keep a compact ledger instead of rereading snippets.",
    {
      sessionId: z.string().describe("Stable ID for the agent/session/task"),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ sessionId, repo }) => {
      try {
        return await withRepoDatabase(repo, routedDb, async (activeDb) => {
          const summary = compactSessionContext(sessionId, activeDb);
          const lines = [
            "Compact session context",
            "Session: " + summary.sessionId,
            "Entries: " + summary.entries,
            "Total tokens: " + summary.totalTokens,
            "Files: " + formatList(summary.files),
            "Symbols: " + formatList(summary.symbols),
            "Chunks: " + formatList(summary.chunks),
            "Evidence: " + formatList(summary.evidenceIds),
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory setup --project .\` for full AI onboarding, or \`code-memory bootstrap --project .\` for index-only initialization.`,
            }],
            isError: false,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "reset_context_session",
    "Delete the context ledger entries for a session when the agent starts a materially new task.",
    {
      sessionId: z.string().describe("Stable ID for the agent/session/task"),
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
    },
    async ({ sessionId, repo }) => {
      try {
        return await withRepoDatabase(repo, routedDb, async (activeDb) => {
          const removed = resetContextSession(sessionId, activeDb);
          return { content: [{ type: "text" as const, text: "Removed ledger entries: " + removed }] };
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isUninitializedRepo = errorMsg.includes("is not registered") || errorMsg.includes("does not contain");

        if (isUninitializedRepo) {
          return {
            content: [{
              type: "text" as const,
              text: `=== [CODE-MEMORY BOOTSTRAP PROTOCOL] ===\nTarget repository has NO indexes compiled yet.\n-> Run \`code-memory setup --project .\` for full AI onboarding, or \`code-memory bootstrap --project .\` for index-only initialization.`,
            }],
            isError: false,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );
}

function formatDelta(delta: ReturnType<typeof getContextDeltaForDb>): string {
  return [
    "Context delta",
    "Prior tokens: " + delta.totalPriorTokens,
    "New files: " + formatList(delta.newFiles),
    "Repeated files: " + formatList(delta.repeatedFiles),
    "New symbols: " + formatList(delta.newSymbols),
    "Repeated symbols: " + formatList(delta.repeatedSymbols),
    "New chunks: " + formatList(delta.newChunks),
    "Repeated chunks: " + formatList(delta.repeatedChunks),
    "New evidence: " + formatList(delta.newEvidenceIds),
    "Repeated evidence: " + formatList(delta.repeatedEvidenceIds),
    "Novelty score: " + delta.noveltyScore.toFixed(2),
    "Repeated penalty: " + delta.repeatedPenalty.toFixed(2),
    "Prior evidence: " + formatList(delta.evidenceIds),
  ].join("\n");
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "(none)";
}
