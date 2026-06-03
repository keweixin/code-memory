/**
 * MCP Tool Registry
 *
 * Registers all MCP tools on a McpServer instance.
 * Each tool is defined in its own file under tools/.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SqlJsDatabase } from "../storage/database.js";
import type { VectorSearchProvider } from "../search/vector-search.js";
import { createLogger } from "../shared/logger.js";
import { withIndexDiagnostics } from "./index-diagnostics.js";
import type { VectorSearchProviderResolver } from "./vector-provider-router.js";

import { registerGetProjectCardTool } from "./tools/get-project-card.js";
import { registerGetRepoMapTool } from "./tools/get-repo-map.js";
import { registerSearchCodeTool } from "./tools/search-code.js";
import { registerSearchSymbolsTool } from "./tools/search-symbols.js";
import { registerFindDefinitionTool } from "./tools/find-definition.js";
import { registerFindReferencesTool } from "./tools/find-references.js";
import { registerGetCallGraphTool } from "./tools/get-call-graph.js";
import { registerGetDependencyGraphTool } from "./tools/get-dependency-graph.js";
import { registerImpactAnalysisTool } from "./tools/impact-analysis.js";
import { registerGetRouteMapTool } from "./tools/get-route-map.js";
import { registerGetRelatedTestsTool } from "./tools/get-related-tests.js";
import { registerGetCommunityTool } from "./tools/get-community.js";
import { registerGetProcessTool } from "./tools/get-process.js";
import { registerGetContextPackTool } from "./tools/get-context-pack.js";
import { registerPlanContextTool } from "./tools/plan-context.js";
import { registerRememberProjectFactTool } from "./tools/remember-project-fact.js";
import { registerInvalidateMemoryTool } from "./tools/invalidate-memory.js";
import { registerExplainModuleTool } from "./tools/explain-module.js";
import { registerContextLedgerTools } from "./tools/context-ledger.js";
import { registerGetUnifiedRepoMapTool } from "./tools/get-unified-repo-map.js";
import { registerResolveProjectTool } from "./tools/resolve-project.js";

const log = createLogger("mcp:tool-registry");

/**
 * Wrap an McpServer so that every tool handler appends an
 * `X-Response-Time-Ms` text content item to the result.
 */
function withResponseTiming(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const timedServer = Object.create(server) as McpServer;

  (timedServer as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const toolName = typeof args[0] === 'string' ? args[0] : '';
    if (typeof args[1] === 'string') {
      args[1] = appendToolDescriptionGuidance(toolName, args[1]);
    }

    const maybeHandler = args[args.length - 1];
    if (typeof maybeHandler !== 'function') {
      return originalTool(...args);
    }

    const wrappedHandler = async (...handlerArgs: unknown[]) => {
      const startMs = performance.now();
      const result = await (maybeHandler as (...a: unknown[]) => Promise<unknown>)(...handlerArgs);
      const elapsedMs = performance.now() - startMs;

      if (isToolResult(result)) {
        const hint = getNextStepHint(toolName);
        if (hint) {
          result.content.push({
            type: 'text' as const,
            text: hint,
          });
        }
        result.content.push({
          type: 'text' as const,
          text: `[X-Response-Time-Ms: ${elapsedMs.toFixed(0)}]`,
        });
      }

      return result;
    };

    return originalTool(...args.slice(0, -1), wrappedHandler);
  };

  return timedServer;
}

function appendToolDescriptionGuidance(toolName: string, description: string): string {
  const guidance = getToolWorkflowGuidance(toolName);
  if (!guidance) return description;
  return description + " " + guidance;
}

function getToolWorkflowGuidance(toolName: string): string {
  if (toolName === 'plan_context') {
    return 'WHEN TO USE: after resolve_project confirms the repo is ready. AFTER THIS: call get_context_pack or search_code.';
  }
  if (toolName === 'resolve_project') {
    return 'WHEN TO USE: first call for a new task, repo switch, missing index, or cwd mismatch. AFTER THIS: call plan_context if ready, otherwise run the returned bootstrap/index command.';
  }
  if (toolName === 'get_context_pack' || toolName === 'search_code') {
    return 'WHEN TO USE: understand a feature or find code after plan_context. AFTER THIS: call search_symbols, then find_definition or find_references for exact symbols.';
  }
  if (toolName === 'search_symbols' || toolName === 'find_definition' || toolName === 'find_references') {
    return 'WHEN TO USE: locate and inspect named symbols. AFTER THIS: call impact_analysis before editing shared code, public contracts, or startup/index lifecycle paths.';
  }
  if (toolName === 'impact_analysis') {
    return 'WHEN TO USE: before modifying a symbol, file, route, or public contract. AFTER THIS: call get_related_tests and run repository tests after edits.';
  }
  if (toolName === 'get_related_tests') {
    return 'WHEN TO USE: choose narrow validation after context or impact analysis. AFTER THIS: run the suggested tests outside MCP.';
  }
  if (toolName === 'remember_project_fact' || toolName === 'invalidate_memory') {
    return 'WHEN TO USE: preserve durable project knowledge or remove stale facts after verified changes. AFTER THIS: restart with plan_context for a new task or get_context_pack for the active task.';
  }
  return 'WHEN TO USE: use after plan_context when this specific map or graph is needed. AFTER THIS: prefer search_symbols -> find_definition/find_references before editing.';
}

function getNextStepHint(toolName: string): string {
  if (toolName === 'plan_context') {
    return '[Next: call get_context_pack for bounded evidence, or search_code if you only need ranked matches.]';
  }
  if (toolName === 'resolve_project') {
    return '[Next: if status is ready call plan_context; otherwise run the returned bootstrap/index command.]';
  }
  if (toolName === 'get_context_pack' || toolName === 'search_code') {
    return '[Next: pick a symbol/file from the results, then call search_symbols -> find_definition/find_references.]';
  }
  if (toolName === 'search_symbols' || toolName === 'find_definition' || toolName === 'find_references') {
    return '[Next: before editing, call impact_analysis on the exact symbol or file; after editing, call get_related_tests.]';
  }
  if (toolName === 'impact_analysis') {
    return '[Next: review affected files, call get_related_tests, then run the suggested repository tests after changes.]';
  }
  if (toolName === 'get_related_tests') {
    return '[Next: run the listed tests via the project CLI, then use remember_project_fact/invalidate_memory for durable verified knowledge if useful.]';
  }
  return '[Next: for a new task use plan_context; for edits use impact_analysis before changing code.]';
}

function isToolResult(value: unknown): value is { content: unknown[] } {
  return typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content);
}

export interface ToolRegistryOptions {
  vectorSearchProvider?: VectorSearchProvider | null;
  vectorSearchProviderResolver?: VectorSearchProviderResolver;
}

/**
 * Register all MCP tools on the given server instance.
 *
 * In fixed-project mode, the database is initialized before registration.
 * In global auto-project mode, tools resolve and open project databases lazily.
 */
export function registerAllTools(
  server: McpServer,
  db?: SqlJsDatabase,
  options: ToolRegistryOptions = {},
): void {
  log.info("Registering MCP tools...");
  const diagnosticServer = withIndexDiagnostics(server, db);
  const timedServer = withResponseTiming(diagnosticServer);
  const routedDb = db as SqlJsDatabase;

  // ---- Navigation & Discovery ----
  registerResolveProjectTool(timedServer);
  registerGetProjectCardTool(timedServer, routedDb);
  registerGetRepoMapTool(timedServer, routedDb);

  // ---- Search ----
  registerSearchCodeTool(
    timedServer,
    routedDb,
    options.vectorSearchProvider,
    options.vectorSearchProviderResolver,
  );
  registerSearchSymbolsTool(timedServer, routedDb);

  // ---- Symbol Navigation ----
  registerFindDefinitionTool(timedServer, routedDb);
  registerFindReferencesTool(timedServer, routedDb);

  // ---- Graph Analysis ----
  registerGetCallGraphTool(timedServer, routedDb);
  registerGetDependencyGraphTool(timedServer, routedDb);
  registerImpactAnalysisTool(timedServer, routedDb);
  registerGetRouteMapTool(timedServer, routedDb);
  registerGetCommunityTool(timedServer, routedDb);
  registerGetProcessTool(timedServer, routedDb);

  // ---- Testing ----
  registerGetRelatedTestsTool(timedServer, routedDb);

  // ---- Context ----
  registerPlanContextTool(timedServer, routedDb);
  registerGetContextPackTool(
    timedServer,
    routedDb,
    options.vectorSearchProvider,
    options.vectorSearchProviderResolver,
  );

  // ---- Memory ----
  registerRememberProjectFactTool(timedServer, routedDb);
  registerInvalidateMemoryTool(timedServer, routedDb);
  registerContextLedgerTools(timedServer, routedDb);

  // ---- Understanding ----
  registerExplainModuleTool(timedServer, routedDb);

  // ---- Multi-Repo ----
  registerGetUnifiedRepoMapTool(timedServer, db);

  log.info("All 26 MCP tools registered");
}
