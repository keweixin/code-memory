/**
 * MCP Tool Registry
 *
 * Registers all MCP tools on a McpServer instance.
 * Each tool is defined in its own file under tools/.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SqlJsDatabase } from "../storage/database.js";
import { createLogger } from "../shared/logger.js";

import { registerGetProjectCardTool } from "./tools/get-project-card.js";
import { registerGetRepoMapTool } from "./tools/get-repo-map.js";
import { registerSearchCodeTool } from "./tools/search-code.js";
import { registerSearchSymbolsTool } from "./tools/search-symbols.js";
import { registerFindDefinitionTool } from "./tools/find-definition.js";
import { registerFindReferencesTool } from "./tools/find-references.js";
import { registerGetCallGraphTool } from "./tools/get-call-graph.js";
import { registerGetDependencyGraphTool } from "./tools/get-dependency-graph.js";
import { registerImpactAnalysisTool } from "./tools/impact-analysis.js";
import { registerGetRelatedTestsTool } from "./tools/get-related-tests.js";
import { registerGetContextPackTool } from "./tools/get-context-pack.js";
import { registerRememberProjectFactTool } from "./tools/remember-project-fact.js";
import { registerInvalidateMemoryTool } from "./tools/invalidate-memory.js";
import { registerExplainModuleTool } from "./tools/explain-module.js";

const log = createLogger("mcp:tool-registry");

/**
 * Register all MCP tools on the given server instance.
 *
 * The database must already be initialized (via getDatabase()).
 * Each tool receives the database instance for direct queries.
 */
export function registerAllTools(server: McpServer, db: SqlJsDatabase): void {
  log.info("Registering MCP tools...");

  // ---- Navigation & Discovery ----
  registerGetProjectCardTool(server, db);
  registerGetRepoMapTool(server, db);

  // ---- Search ----
  registerSearchCodeTool(server, db);
  registerSearchSymbolsTool(server, db);

  // ---- Symbol Navigation ----
  registerFindDefinitionTool(server, db);
  registerFindReferencesTool(server, db);

  // ---- Graph Analysis ----
  registerGetCallGraphTool(server, db);
  registerGetDependencyGraphTool(server, db);
  registerImpactAnalysisTool(server, db);

  // ---- Testing ----
  registerGetRelatedTestsTool(server, db);

  // ---- Context ----
  registerGetContextPackTool(server, db);

  // ---- Memory ----
  registerRememberProjectFactTool(server, db);
  registerInvalidateMemoryTool(server, db);

  // ---- Understanding ----
  registerExplainModuleTool(server, db);

  log.info("All 14 MCP tools registered");
}
