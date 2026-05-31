/**
 * MCP Tools: Context Ledger
 *
 * Session-level bookkeeping for context already returned to an agent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getContextDelta,
  getContextLedgerEntries,
  markContextUsed,
  updateContextFeedback,
} from "../../memory/context-ledger.js";
import type { ContextFeedback } from "../../shared/types.js";

const FEEDBACK_VALUES = ["useful", "irrelevant", "stale"] as const;

export function registerContextLedgerTools(server: McpServer): void {
  server.tool(
    "mark_context_used",
    "Record files, symbols, chunks, token estimate, and evidence already returned to an agent session. " +
    "Use this after sending context so later retrieval can avoid repeated context.",
    {
      sessionId: z.string().describe("Stable ID for the agent/session/task"),
      query: z.string().describe("Task or query that caused this context to be returned"),
      returnedFiles: z.array(z.string()).optional().default([]),
      returnedSymbols: z.array(z.string()).optional().default([]),
      returnedChunks: z.array(z.string()).optional().default([]),
      tokenEstimate: z.number().optional().default(0),
      evidenceIds: z.array(z.string()).optional().default([]),
      agentFeedback: z.enum(FEEDBACK_VALUES).optional(),
    },
    async (input) => {
      const id = markContextUsed({
        sessionId: input.sessionId,
        query: input.query,
        returnedFiles: input.returnedFiles,
        returnedSymbols: input.returnedSymbols,
        returnedChunks: input.returnedChunks,
        tokenEstimate: input.tokenEstimate,
        evidenceIds: input.evidenceIds,
        agentFeedback: input.agentFeedback as ContextFeedback | undefined,
      });
      return { content: [{ type: "text" as const, text: "Context ledger entry recorded: " + id }] };
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
    },
    async ({ sessionId, candidateFiles, candidateSymbols, candidateChunks }) => {
      const delta = getContextDelta(sessionId, {
        files: candidateFiles,
        symbols: candidateSymbols,
        chunks: candidateChunks,
      });
      return { content: [{ type: "text" as const, text: formatDelta(delta) }] };
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
    },
    async ({ sessionId, candidateFiles, candidateSymbols, candidateChunks }) => {
      const delta = getContextDelta(sessionId, {
        files: candidateFiles,
        symbols: candidateSymbols,
        chunks: candidateChunks,
      });
      const lines = [
        "Context repetition check",
        "Prior tokens: " + delta.totalPriorTokens,
        "Keep files: " + formatList(delta.newFiles),
        "Drop repeated files: " + formatList(delta.repeatedFiles),
        "Keep symbols: " + formatList(delta.newSymbols),
        "Drop repeated symbols: " + formatList(delta.repeatedSymbols),
        "Keep chunks: " + formatList(delta.newChunks),
        "Drop repeated chunks: " + formatList(delta.repeatedChunks),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
    },
    async ({ sessionId, contextId, contextType, feedback }) => {
      const entries = getContextLedgerEntries(sessionId);
      if (feedback && entries.length > 0) {
        updateContextFeedback(entries[entries.length - 1].id, feedback as ContextFeedback);
      }
      const seenIn = entries.filter((entry) => {
        if (contextType === "file") return entry.returnedFiles.includes(contextId);
        if (contextType === "symbol") return entry.returnedSymbols.includes(contextId);
        return entry.returnedChunks.includes(contextId);
      });
      const lines = [
        contextId + " is " + (seenIn.length > 0 ? "repeated" : "new") + " for session " + sessionId,
        "Seen in entries: " + seenIn.length,
        "Prior tokens: " + entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0),
      ];
      for (const entry of seenIn.slice(-5)) {
        lines.push("- " + entry.createdAt + " query=\"" + entry.query + "\" feedback=" + (entry.agentFeedback || "none"));
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}

function formatDelta(delta: ReturnType<typeof getContextDelta>): string {
  return [
    "Context delta",
    "Prior tokens: " + delta.totalPriorTokens,
    "New files: " + formatList(delta.newFiles),
    "Repeated files: " + formatList(delta.repeatedFiles),
    "New symbols: " + formatList(delta.newSymbols),
    "Repeated symbols: " + formatList(delta.repeatedSymbols),
    "New chunks: " + formatList(delta.newChunks),
    "Repeated chunks: " + formatList(delta.repeatedChunks),
    "Prior evidence: " + formatList(delta.evidenceIds),
  ].join("\n");
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "(none)";
}
