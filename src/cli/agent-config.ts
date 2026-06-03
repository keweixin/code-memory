import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODE_MEMORY_MARKER_END,
  CODE_MEMORY_MARKER_START,
  getManagedInstructionBlock,
} from '../mcp/server-instructions.js';

export type AgentName = 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode';
export type AgentSelector = AgentName | 'auto';
export type RuntimeName = 'npx' | 'global' | 'local';

interface McpLaunchSpec {
  command: string;
  args: string[];
}

export interface AgentConfigChange {
  agent: AgentName;
  filePath: string;
  action: 'create' | 'update' | 'remove' | 'noop';
  changed: boolean;
  before: string;
  after: string;
}

export interface AgentConfigOptions {
  agent?: AgentSelector;
  all?: boolean;
  dryRun?: boolean;
  projectRoot?: string;
  homeDir?: string;
  runtime?: RuntimeName;
  bindProject?: boolean;
}

export const SUPPORTED_AGENTS: AgentName[] = ['claude', 'cursor', 'codex', 'gemini', 'opencode'];

export function setupAgents(options: AgentConfigOptions = {}): AgentConfigChange[] {
  const changes = getTargetAgents(options).map((agent) => buildSetupChange(agent, options));
  if (!options.dryRun) {
    for (const change of changes) writeChange(change);
  }
  return changes;
}

export function uninstallAgents(options: AgentConfigOptions = {}): AgentConfigChange[] {
  const changes = getTargetAgents(options).map((agent) => buildUninstallChange(agent, options));
  if (!options.dryRun) {
    for (const change of changes) writeChange(change);
  }
  return changes;
}

export function formatAgentChanges(changes: AgentConfigChange[], dryRun: boolean): string {
  const lines = [
    dryRun ? 'Code Memory setup dry run' : 'Code Memory agent configuration',
    '',
  ];
  for (const change of changes) {
    lines.push(`${change.changed ? 'CHANGE' : 'NOOP'} ${change.agent} ${change.action}: ${change.filePath}`);
    if (dryRun && change.changed) {
      lines.push('--- before');
      lines.push(change.before || '(empty)');
      lines.push('--- after');
      lines.push(change.after || '(empty)');
    }
  }
  return lines.join('\n');
}

function getTargetAgents(options: AgentConfigOptions): AgentName[] {
  if (options.all) return SUPPORTED_AGENTS;
  if (options.agent === 'auto') return detectAgents(options);
  return [options.agent || 'codex'];
}

function detectAgents(options: AgentConfigOptions): AgentName[] {
  const detected = SUPPORTED_AGENTS.filter((agent) => existsSync(getAgentConfigPath(agent, options)));
  return detected.length > 0 ? detected : ['codex'];
}

function getHomeDir(options: AgentConfigOptions): string {
  return options.homeDir || process.env.CODE_MEMORY_TEST_HOME || homedir();
}

function getProjectRoot(options: AgentConfigOptions): string {
  return resolve(options.projectRoot || process.cwd());
}

function getRuntime(options: AgentConfigOptions): RuntimeName {
  const runtime = options.runtime || 'npx';
  if (runtime === 'npx' || runtime === 'global' || runtime === 'local') return runtime;
  throw new Error('--runtime must be one of: npx, global, local');
}

function getMcpLaunchSpec(projectRoot: string, runtime: RuntimeName, bindProject = false): McpLaunchSpec {
  const serveArgs = bindProject
    ? ['serve', '--watch', '--project', projectRoot]
    : ['serve', '--watch', '--auto-project'];
  if (runtime === 'global') {
    return { command: 'code-memory', args: serveArgs };
  }
  if (runtime === 'local') {
    const distIndexPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'index.js');
    return { command: 'node', args: [distIndexPath, ...serveArgs] };
  }
  return { command: 'npx', args: ['-y', 'code-memory@latest', ...serveArgs] };
}

function buildSetupChange(agent: AgentName, options: AgentConfigOptions): AgentConfigChange {
  const filePath = getAgentConfigPath(agent, options);
  const before = readText(filePath);
  const projectRoot = getProjectRoot(options);
  const launch = getMcpLaunchSpec(projectRoot, getRuntime(options), Boolean(options.bindProject));
  const after = isJsonAgent(agent)
    ? applyJsonMcpConfig(before, launch)
    : applyManagedBlock(before, getAgentBlock(agent, launch));
  return {
    agent,
    filePath,
    action: before ? 'update' : 'create',
    changed: before !== after,
    before,
    after,
  };
}

function buildUninstallChange(agent: AgentName, options: AgentConfigOptions): AgentConfigChange {
  const filePath = getAgentConfigPath(agent, options);
  const before = readText(filePath);
  const after = isJsonAgent(agent)
    ? removeJsonMcpConfig(before)
    : removeManagedBlock(before).trimEnd();
  return {
    agent,
    filePath,
    action: before && before !== after ? 'remove' : 'noop',
    changed: before !== after,
    before,
    after,
  };
}

function getAgentConfigPath(agent: AgentName, options: AgentConfigOptions): string {
  const home = getHomeDir(options);
  const projectRoot = getProjectRoot(options);
  switch (agent) {
    case 'codex':
      return join(home, '.codex', 'config.toml');
    case 'cursor':
      return join(projectRoot, '.cursor', 'mcp.json');
    case 'claude':
      return join(projectRoot, 'CLAUDE.md');
    case 'gemini':
      return join(projectRoot, '.gemini', 'settings.json');
    case 'opencode':
      return join(projectRoot, 'opencode.json');
  }
}

function getAgentBlock(agent: AgentName, launch: McpLaunchSpec): string {
  if (agent === 'codex') {
    return [
      '# ' + CODE_MEMORY_MARKER_START,
      '[mcp_servers.code-memory]',
      `command = ${JSON.stringify(launch.command)}`,
      `args = ${JSON.stringify(launch.args)}`,
      '# ' + CODE_MEMORY_MARKER_END,
    ].join('\n');
  }

  if (agent === 'claude') {
    return getManagedInstructionBlock(launch.command, launch.args);
  }

  throw new Error('JSON agents are handled by applyJsonMcpConfig: ' + agent);
}

function applyManagedBlock(text: string, block: string): string {
  const cleaned = removeManagedBlock(text).trimEnd();
  return (cleaned ? cleaned + '\n\n' : '') + block + '\n';
}

function removeManagedBlock(text: string): string {
  const escapedStart = escapeRegExp(CODE_MEMORY_MARKER_START);
  const escapedEnd = escapeRegExp(CODE_MEMORY_MARKER_END);
  return text
    .replace(new RegExp(`#\\s*${escapedStart}[\\s\\S]*?#\\s*${escapedEnd}\\s*`, 'g'), '')
    .replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\s*`, 'g'), '');
}

function isJsonAgent(agent: AgentName): boolean {
  return agent === 'cursor' || agent === 'gemini' || agent === 'opencode';
}

function applyJsonMcpConfig(text: string, launch: McpLaunchSpec): string {
  const config = parseJsonObject(text);
  const mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
  mcpServers['code-memory'] = {
    command: launch.command,
    args: launch.args,
  };
  config.mcpServers = mcpServers;
  config.__codeMemoryMarkerStart = CODE_MEMORY_MARKER_START;
  config.__codeMemoryMarkerEnd = CODE_MEMORY_MARKER_END;
  return JSON.stringify(config, null, 2) + '\n';
}

function removeJsonMcpConfig(text: string): string {
  if (!text.trim()) return '';
  const config = parseJsonObject(text);
  if (isRecord(config.mcpServers)) {
    delete config.mcpServers['code-memory'];
  }
  delete config.__codeMemoryMarkerStart;
  delete config.__codeMemoryMarkerEnd;
  const keys = Object.keys(config);
  return keys.length > 0 ? JSON.stringify(config, null, 2) + '\n' : '';
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    const cleaned = removeManagedBlock(text).trim();
    if (!cleaned) return {};
    const parsed = JSON.parse(cleaned);
    return isRecord(parsed) ? parsed : {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readText(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
}

function writeChange(change: AgentConfigChange): void {
  mkdirSync(dirname(change.filePath), { recursive: true });
  writeFileSync(change.filePath, change.after, 'utf-8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
