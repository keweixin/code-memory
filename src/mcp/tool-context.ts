import { z } from 'zod';
import type { ResolveProjectInput } from './project-resolver.js';

export const TOOL_CONTEXT_INPUT_SCHEMA = {
  repo: z.string().optional().describe('Optional registered repo name or repository root path'),
  project: z.string().optional().describe('Optional explicit project root path'),
  cwd: z.string().optional().describe('Optional current working directory used for project resolution'),
  workspaceRoots: z.array(z.string()).optional().describe('Optional MCP client workspace root paths'),
};

export type ToolContextInput = ResolveProjectInput;

export function pickToolContextInput(input: ToolContextInput): ToolContextInput {
  return {
    repo: clean(input.repo),
    project: clean(input.project),
    cwd: clean(input.cwd),
    workspaceRoots: input.workspaceRoots?.map(clean).filter(Boolean) as string[] | undefined,
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
