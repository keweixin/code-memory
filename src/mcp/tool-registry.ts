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

const log = createLogger("mcp:tool-registry");

/**
 * Wrap an McpServer so that every tool handler appends an
 * `X-Response-Time-Ms` text content item to the result.
 */
function withResponseTiming(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const timedServer = Object.create(server) as McpServer;

  (timedServer as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const maybeHandler = args[args.length - 1];
    if (typeof maybeHandler !== 'function') {
      return originalTool(...args);
    }

    const wrappedHandler = async (...handlerArgs: unknown[]) => {
      const startMs = performance.now();
      const result = await (maybeHandler as (...a: unknown[]) => Promise<unknown>)(...handlerArgs);
      const elapsedMs = performance.now() - startMs;

      if (isToolResult(result)) {
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
 * The database must already be initialized (via getDatabase()).
 * Each tool receives the database instance for direct queries.
 */
export function registerAllTools(
  server: McpServer,
  db: SqlJsDatabase,
  options: ToolRegistryOptions = {},
): void {
  log.info("Registering MCP tools...");
  const diagnosticServer = withIndexDiagnostics(server, db);
  const timedServer = withResponseTiming(diagnosticServer);

  // ---- Navigation & Discovery ----
  registerGetProjectCardTool(timedServer, db);
  registerGetRepoMapTool(timedServer, db);

  // ---- Search ----
  registerSearchCodeTool(
    timedServer,
    db,
    options.vectorSearchProvider,
    options.vectorSearchProviderResolver,
  );
  registerSearchSymbolsTool(timedServer, db);

  // ---- Symbol Navigation ----
  registerFindDefinitionTool(timedServer, db);
  registerFindReferencesTool(timedServer, db);

  // ---- Graph Analysis ----
  registerGetCallGraphTool(timedServer, db);
  registerGetDependencyGraphTool(timedServer, db);
  registerImpactAnalysisTool(timedServer, db);
  registerGetRouteMapTool(timedServer, db);
  registerGetCommunityTool(timedServer, db);
  registerGetProcessTool(timedServer, db);

  // ---- Testing ----
  registerGetRelatedTestsTool(timedServer, db);

  // ---- Context ----
  registerPlanContextTool(timedServer, db);
  registerGetContextPackTool(
    timedServer,
    db,
    options.vectorSearchProvider,
    options.vectorSearchProviderResolver,
  );

  // ---- Memory ----
  registerRememberProjectFactTool(timedServer, db);
  registerInvalidateMemoryTool(timedServer, db);
  registerContextLedgerTools(timedServer, db);

  // ---- Understanding ----
  registerExplainModuleTool(timedServer, db);

  // ---- Multi-Repo ----
  registerGetUnifiedRepoMapTool(timedServer, db);

  log.info("All 25 MCP tools registered");
}
