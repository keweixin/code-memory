/**
 * Code Memory Graph -- MCP Server
 *
 * Main entry point for the MCP (Model Context Protocol) server.
 * Initializes the database, creates an McpServer instance,
 * registers all tools, and connects via stdio transport.
 *
 * IMPORTANT: All logging uses console.error() -- NEVER console.log()
 * because stdout is the JSON-RPC transport channel.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDatabase, closeDatabase, isInitialized } from "../storage/database.js";
import { createLogger, setLogLevel } from "../shared/logger.js";
import { VERSION } from "../shared/constants.js";
import { registerAllTools } from "./tool-registry.js";
import { getServerInstructions } from "./server-instructions.js";
import { loadVectorSearchProviderForRepo } from "./vector-provider-router.js";

const log = createLogger("mcp:server");

export interface McpServerLifecycleOptions {
  installSignalHandlers?: boolean;
  registerProcessErrorHandlers?: boolean;
  onShutdownComplete?: (signal: string) => void;
}

/**
 * Create an McpServer instance with all tools registered.
 *
 * This is the factory function -- it initializes the database,
 * creates the server, and registers tools. It does NOT connect
 * the transport. Useful for testing.
 *
 * @param dbPath Optional path to the database directory.
 *               Defaults to process.cwd() + "/.code-memory/index.db".
 * @returns A fully configured McpServer instance.
 */
export async function createMcpServer(dbPath?: string): Promise<McpServer> {
  // Set default log level -- can be overridden via CLAUDE_LOG_LEVEL env
  const envLevel = process.env.CLAUDE_LOG_LEVEL;
  if (envLevel) {
    setLogLevel(envLevel as "debug" | "info" | "warn" | "error" | "silent");
  }

  log.info("Creating MCP server v" + VERSION);

  const projectRoot = dbPath || process.cwd();

  // Initialize database (async WASM bootstrap)
  const db = await getDatabase(projectRoot);
  log.info("Database ready: " + projectRoot);
  const vectorSearchProvider = await loadVectorSearchProviderForRepo(projectRoot);

  // Create McpServer
  const server = new McpServer({
    name: "code-memory",
    version: VERSION,
  }, {
    instructions: getServerInstructions(),
  });

  // Register all tools
  registerAllTools(server, db, {
    vectorSearchProvider,
    vectorSearchProviderResolver: loadVectorSearchProviderForRepo,
  });

  log.info("MCP server created with all tools registered");
  return server;
}

/**
 * Start the MCP server with stdio transport.
 *
 * This is the main entry point for production use.
 * It initializes the database, creates the McpServer,
 * connects the stdio transport, and handles graceful shutdown.
 *
 * @param dbPath Optional path to the database directory.
 */
export async function startServer(
  dbPath?: string,
  options: McpServerLifecycleOptions = {},
): Promise<void> {
  try {
    const server = await createMcpServer(dbPath);

    // Create stdio transport
    const transport = new StdioServerTransport();

    // Handle graceful shutdown
    let shuttingDown = false;

    async function shutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;

      log.info("Received " + signal + " -- shutting down gracefully...");

      try {
        await closeDatabase();
        log.info("Database closed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Error closing database: " + msg);
      }

      options.onShutdownComplete?.(signal);
    }

    // Register signal handlers
    if (options.installSignalHandlers) {
      process.on("SIGINT", function() { shutdown("SIGINT"); });
      process.on("SIGTERM", function() { shutdown("SIGTERM"); });
    }

    // Handle uncaught errors gracefully -- log to stderr, do not crash
    if (options.registerProcessErrorHandlers ?? true) {
      process.on("uncaughtException", function(err: Error) {
        log.error("Uncaught exception: " + err.message, err);
        // Do not exit -- let the MCP transport handle it
      });

      process.on("unhandledRejection", function(reason: unknown) {
        const msg = reason instanceof Error ? reason.message : String(reason);
        log.error("Unhandled rejection: " + msg);
        // Do not exit -- let the MCP transport handle it
      });
    }

    // Connect the server to stdio transport
    log.info("Connecting to stdio transport...");
    await server.connect(transport);

    // Note: We do NOT call console.log() here -- stdout is reserved
    // for the JSON-RPC protocol. All status messages go to stderr.
    log.info("Code Memory MCP Server v" + VERSION + " is running on stdio");
    log.info("Database: " + (isInitialized() ? "initialized" : "NOT initialized"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to start MCP server: " + msg, err instanceof Error ? err : undefined);
    throw err;
  }
}
