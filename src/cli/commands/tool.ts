/**
 * code-memory tool — CLI mirror for MCP tools.
 */

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { closeDatabase, getDatabase } from '../../storage/database.js';
import { createLogger, setLogLevel } from '../../shared/logger.js';
import { registerAllTools } from '../../mcp/tool-registry.js';
import { loadVectorSearchProviderForRepo } from '../../mcp/vector-provider-router.js';
import { resolveProjectPath } from '../project-path.js';

const log = createLogger('tool');

type ToolHandler = (args: unknown) => Promise<unknown> | unknown;
type ToolSchema = Record<string, z.ZodTypeAny>;

interface CollectedTool {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: ToolHandler;
}

interface ToolOptions {
  project?: string;
  args?: string;
  argsFile?: string;
  json?: boolean;
  list?: boolean;
}

export function registerToolCommand(program: Command): void {
  program
    .command('tool [name]')
    .description('Run any MCP tool from the CLI for debugging and scripting')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .option('--args <json>', 'JSON object to pass as MCP tool arguments', '{}')
    .option('--args-file <path>', 'Read MCP tool arguments from a JSON file')
    .option('--json', 'Print the raw MCP tool result as JSON')
    .option('--list', 'List mirrored MCP tool names')
    .action(async (name: string | undefined, options: ToolOptions) => {
      try {
        await runMcpToolFromCli(name, options);
      } catch (err) {
        log.error('Tool command failed', err);
        process.exit(1);
      }
    });
}

export async function runMcpToolFromCli(name: string | undefined, options: ToolOptions): Promise<void> {
  setLogLevel('silent');

  try {
    const projectRoot = shouldUseGlobalToolMirror(name, options) ? undefined : resolveProjectPath(options);
    const tools = await collectMcpTools(projectRoot);

    if (options.list) {
      for (const tool of tools.values()) {
        console.log(`${tool.name}\t${tool.description}`);
      }
      return;
    }

    if (!name) {
      throw new Error('Missing tool name. Use "code-memory tool --list" to inspect available tools.');
    }

    const tool = tools.get(name);
    if (!tool) {
      throw new Error(`Unknown MCP tool "${name}". Use "code-memory tool --list" to inspect available tools.`);
    }

    const rawArgs = parseToolArgs(options);
    if (isGlobalProjectTool(name) && options.project && !rawArgs.project && !rawArgs.repo) {
      rawArgs.project = resolveProjectPath(options);
    }
    const args = parseWithToolSchema(tool, rawArgs);
    const result = await tool.handler(args);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(formatToolResult(result));
  } finally {
    await closeDatabase();
  }
}

function shouldUseGlobalToolMirror(name: string | undefined, options: ToolOptions): boolean {
  return Boolean(options.list) || isGlobalProjectTool(name);
}

function isGlobalProjectTool(name: string | undefined): boolean {
  return name === 'resolve_project' ||
    name === 'bootstrap_project' ||
    name === 'sync_project' ||
    name === 'register_project';
}

async function collectMcpTools(projectRoot?: string): Promise<Map<string, CollectedTool>> {
  const db = projectRoot ? await getDatabase(projectRoot) : undefined;
  const vectorSearchProvider = projectRoot
    ? await loadVectorSearchProviderForRepo(projectRoot)
    : null;
  const tools = new Map<string, CollectedTool>();
  const collector = {
    tool: (...args: unknown[]) => {
      const name = args[0];
      const description = args[1];
      const schema = args[2];
      const handler = args[args.length - 1];
      if (
        typeof name === 'string' &&
        typeof description === 'string' &&
        isToolSchema(schema) &&
        typeof handler === 'function'
      ) {
        tools.set(name, {
          name,
          description,
          schema,
          handler: handler as ToolHandler,
        });
      }
      return undefined;
    },
  } as unknown as McpServer;

  registerAllTools(collector, db, {
    vectorSearchProvider,
    vectorSearchProviderResolver: loadVectorSearchProviderForRepo,
  });

  return tools;
}

function parseToolArgs(options: ToolOptions): Record<string, unknown> {
  const raw = options.argsFile
    ? readFileSync(options.argsFile, 'utf-8')
    : options.args || '{}';
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function parseWithToolSchema(tool: CollectedTool, args: Record<string, unknown>): unknown {
  return z.object(tool.schema).parse(args);
}

function formatToolResult(result: unknown): string {
  if (!isToolResult(result)) {
    return JSON.stringify(result, null, 2);
  }

  const parts = result.content.map((item) => {
    if (isTextContent(item)) return item.text;
    return JSON.stringify(item, null, 2);
  });

  if (typeof result.isError === 'boolean') {
    parts.push(`[isError: ${result.isError}]`);
  }
  return parts.join('\n\n');
}

function isToolSchema(value: unknown): value is ToolSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is { content: unknown[]; isError?: boolean } {
  return typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content);
}

function isTextContent(value: unknown): value is { type: 'text'; text: string } {
  return typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string';
}
