import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatProjectResolution, resolveProject } from "../project-resolver.js";
import { formatStructuredToolResult, toolResultFromResolution } from "../tool-result.js";

export function registerResolveProjectTool(server: McpServer): void {
  server.tool(
    "resolve_project",
    "Resolve the active Code Memory project and database before any code exploration. WHEN TO USE: first call for a new task, repo switch, or when tools report missing/stale index. AFTER THIS: call plan_context if status is ready; otherwise call bootstrap_project, sync_project, or register_project before using Read/Grep/Glob.",
    {
      repo: z.string().optional().describe("Optional registered repo name or repository root path"),
      project: z.string().optional().describe("Optional explicit project root path"),
    },
    async ({ repo, project }) => {
      const resolution = resolveProject({ repo, project });
      const display = formatProjectResolution(resolution);
      return {
        content: [{
          type: "text" as const,
          text: formatStructuredToolResult(toolResultFromResolution(
            resolution,
            { resolution },
            display,
          )),
        }],
      };
    },
  );
}
