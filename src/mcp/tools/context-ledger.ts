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
import { TOOL_CONTEXT_INPUT_SCHEMA } from "../tool-context.js";
import { errorToolResult, formatStructuredToolResult, toolResultFromProject } from "../tool-result.js";

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
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async (input) => {
      try {
        return await withRepoDatabase(input, routedDb, async (activeDb, projectRoot, resolution) => {
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
          const display = "Context ledger entry recorded: " + id;
          return ledgerResult(activeDb, projectRoot, resolution.repoName ?? "", {
            entryId: id,
            sessionId: input.sessionId,
            query: input.query,
            returnedFiles: input.returnedFiles,
            returnedSymbols: input.returnedSymbols,
            returnedChunks: input.returnedChunks,
            tokenEstimate: input.tokenEstimate,
          }, display, {
            tool: "get_context_delta",
            reason: "Use get_context_delta before returning more context for this session.",
          });
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: formatStructuredToolResult(errorToolResult(errorMsg, { sessionId: input.sessionId })) }],
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
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ sessionId, candidateFiles, candidateSymbols, candidateChunks, candidateEvidenceIds, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, routedDb, async (activeDb, projectRoot, resolution) => {
          const delta = getContextDeltaForDb(sessionId, {
            files: candidateFiles,
            symbols: candidateSymbols,
            chunks: candidateChunks,
            evidenceIds: candidateEvidenceIds,
          }, activeDb);
          const display = formatDelta(delta);
          return ledgerResult(activeDb, projectRoot, resolution.repoName ?? "", {
            sessionId,
            candidateFiles,
            candidateSymbols,
            candidateChunks,
            candidateEvidenceIds,
            delta,
          }, display, {
            tool: "get_context_pack",
            reason: "Use the delta to prefer new context and avoid repeated evidence.",
          });
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: formatStructuredToolResult(errorToolResult(errorMsg, { sessionId })) }],
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
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ sessionId, candidateFiles, candidateSymbols, candidateChunks, candidateEvidenceIds, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, routedDb, async (activeDb, projectRoot, resolution) => {
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
          const display = lines.join("\n");
          return ledgerResult(activeDb, projectRoot, resolution.repoName ?? "", {
            sessionId,
            candidateFiles,
            candidateSymbols,
            candidateChunks,
            candidateEvidenceIds,
            delta,
            keep: {
              files: delta.newFiles,
              symbols: delta.newSymbols,
              chunks: delta.newChunks,
              evidenceIds: delta.newEvidenceIds,
            },
            drop: {
              files: delta.repeatedFiles,
              symbols: delta.repeatedSymbols,
              chunks: delta.repeatedChunks,
              evidenceIds: delta.repeatedEvidenceIds,
            },
          }, display, {
            tool: "get_context_pack",
            reason: "Keep new context and drop repeated context when building the next pack.",
          });
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: formatStructuredToolResult(errorToolResult(errorMsg, { sessionId })) }],
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
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ sessionId, contextId, contextType, feedback, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, routedDb, async (activeDb, projectRoot, resolution) => {
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
          const display = lines.join("\n");
          return ledgerResult(activeDb, projectRoot, resolution.repoName ?? "", {
            sessionId,
            contextId,
            contextType,
            feedback: feedback ?? null,
            repeated: seenIn.length > 0,
            seenCount: seenIn.length,
            priorTokens: entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0),
            seenEntries: seenIn,
          }, display, {
            tool: "get_context_delta",
            reason: "Use get_context_delta to decide whether this context should be reused or replaced.",
          });
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: formatStructuredToolResult(errorToolResult(errorMsg, { sessionId, contextId, contextType })) }],
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
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ sessionId, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, routedDb, async (activeDb, projectRoot, resolution) => {
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
          const display = lines.join("\n");
          return ledgerResult(activeDb, projectRoot, resolution.repoName ?? "", summary, display, {
            tool: "get_context_delta",
            reason: "Use this compact summary to avoid rereading already-returned context.",
          });
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: formatStructuredToolResult(errorToolResult(errorMsg, { sessionId })) }],
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
      ...TOOL_CONTEXT_INPUT_SCHEMA,
    },
    async ({ sessionId, repo, project, cwd, workspaceRoots }) => {
      try {
        return await withRepoDatabase({ repo, project, cwd, workspaceRoots }, routedDb, async (activeDb, projectRoot, resolution) => {
          const removed = resetContextSession(sessionId, activeDb);
          const display = "Removed ledger entries: " + removed;
          return ledgerResult(activeDb, projectRoot, resolution.repoName ?? "", {
            sessionId,
            removed,
          }, display, {
            tool: "plan_context",
            reason: "Session ledger was reset. Start the next retrieval with plan_context.",
          });
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: formatStructuredToolResult(errorToolResult(errorMsg, { sessionId })) }],
          isError: true,
        };
      }
    },
  );
}

function ledgerResult<T>(
  db: SqlJsDatabase,
  projectRoot: string,
  repoName: string,
  data: T,
  display: string,
  nextAction: { tool?: string; command?: string; reason: string },
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{
      type: "text",
      text: formatStructuredToolResult(toolResultFromProject(
        projectRoot,
        repoName,
        db,
        data,
        display,
        nextAction,
      )),
    }],
  };
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
