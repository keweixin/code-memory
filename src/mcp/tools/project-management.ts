/**
 * MCP Tools: global project management
 *
 * These tools intentionally do not require an open project database. They let a
 * global MCP server bootstrap, sync, and register projects before retrieval.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bootstrapProject } from "../../cli/commands/bootstrap.js";
import { indexProject } from "../../cli/commands/index.js";
import { registerRepo } from "../../cli/registry.js";
import { createLogger } from "../../shared/logger.js";
import { formatProjectResolution, resolveProject } from "../project-resolver.js";

const log = createLogger("mcp:project-management");

const PROJECT_INPUT_SCHEMA = {
  repo: z.string().optional().describe("Optional registered repo name or repository root path"),
  project: z.string().optional().describe("Optional project root path"),
};

export function registerProjectManagementTools(server: McpServer): void {
  server.tool(
    "bootstrap_project",
    "Initialize or refresh a Code Memory project from inside MCP. " +
    "Does not require an existing database. Use after resolve_project returns needs_bootstrap or needs_index.",
    {
      ...PROJECT_INPUT_SCHEMA,
      embedding: z.string().optional().default("none").describe("Embedding provider: ollama | openai | none"),
      workers: z.string().optional().default("auto").describe("Parse worker count"),
    },
    async ({ repo, project, embedding, workers }) => {
      const resolution = resolveProject({ repo, project });
      if (!resolution.projectRoot) return resolutionResult("bootstrap_project", resolution, false);

      await bootstrapProject({
        project: resolution.projectRoot,
        embedding,
        workers,
      });
      const after = resolveProject({ project: resolution.projectRoot });
      log.info("Bootstrapped project: " + resolution.projectRoot);
      return resolutionResult("bootstrap_project", after, true);
    },
  );

  server.tool(
    "sync_project",
    "Incrementally synchronize a Code Memory project from inside MCP. " +
    "Does not require a startup database. Use when resolve_project reports stale.",
    {
      ...PROJECT_INPUT_SCHEMA,
      workers: z.string().optional().default("auto").describe("Parse worker count"),
    },
    async ({ repo, project, workers }) => {
      const resolution = resolveProject({ repo, project });
      if (!resolution.projectRoot || !resolution.indexExists) {
        return resolutionResult("sync_project", resolution, false);
      }

      await indexProject(resolution.projectRoot, {
        full: false,
        workers,
      });
      const after = resolveProject({ project: resolution.projectRoot });
      log.info("Synced project: " + resolution.projectRoot);
      return resolutionResult("sync_project", after, true);
    },
  );

  server.tool(
    "register_project",
    "Register a project in the global Code Memory registry from inside MCP. " +
    "Does not require an existing database. Use after setup/bootstrap or when repo routing cannot find a known project.",
    {
      ...PROJECT_INPUT_SCHEMA,
      name: z.string().optional().describe("Optional registry name. Defaults to project directory name."),
    },
    async ({ repo, project, name }) => {
      const resolution = resolveProject({ repo, project });
      if (!resolution.projectRoot) return resolutionResult("register_project", resolution, false);

      const entry = registerRepo(resolution.projectRoot, name);
      const after = resolveProject({ project: resolution.projectRoot });
      log.info("Registered project: " + entry.name + " -> " + entry.rootPath);
      return {
        content: [{
          type: "text" as const,
          text: [
            "register_project complete",
            "Registered repo: " + entry.name + " -> " + entry.rootPath,
            "",
            formatProjectResolution(after),
          ].join("\n"),
        }],
      };
    },
  );
}

function resolutionResult(
  toolName: string,
  resolution: ReturnType<typeof resolveProject>,
  changed: boolean,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const ready = resolution.status === "ready" || resolution.status === "stale";
  return {
    content: [{
      type: "text" as const,
      text: [
        toolName + (changed ? " complete" : " skipped"),
        "",
        formatProjectResolution(resolution),
      ].join("\n"),
    }],
    isError: !changed && !ready,
  };
}
