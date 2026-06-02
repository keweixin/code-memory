import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CODE_MEMORY_MARKER_END,
  CODE_MEMORY_MARKER_START,
  getManagedInstructionBlock,
} from '../mcp/server-instructions.js';

export type AgentName = 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode';

export interface AgentConfigChange {
  agent: AgentName;
  filePath: string;
  action: 'create' | 'update' | 'remove' | 'noop';
  changed: boolean;
  before: string;
  after: string;
}

export interface AgentConfigOptions {
  agent?: AgentName;
  all?: boolean;
  dryRun?: boolean;
  projectRoot?: string;
  homeDir?: string;
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
  return [options.agent || 'codex'];
}

function getHomeDir(options: AgentConfigOptions): string {
  return options.homeDir || process.env.CODE_MEMORY_TEST_HOME || homedir();
}

function getProjectRoot(options: AgentConfigOptions): string {
  return options.projectRoot || process.cwd();
}

function buildSetupChange(agent: AgentName, options: AgentConfigOptions): AgentConfigChange {
  const filePath = getAgentConfigPath(agent, options);
  const before = readText(filePath);
  const after = isJsonAgent(agent)
    ? applyJsonMcpConfig(before, getProjectRoot(options))
    : applyManagedBlock(before, getAgentBlock(agent, getProjectRoot(options)));
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

function getAgentBlock(agent: AgentName, projectRoot: string): string {
  if (agent === 'codex') {
    return [
      '# ' + CODE_MEMORY_MARKER_START,
      '[mcp_servers.code-memory]',
      'command = "code-memory"',
      'args = ["serve", "--watch"]',
      `cwd = ${JSON.stringify(projectRoot)}`,
      '# ' + CODE_MEMORY_MARKER_END,
    ].join('\n');
  }

  if (agent === 'claude') {
    return getManagedInstructionBlock('code-memory', ['serve', '--watch']);
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

function applyJsonMcpConfig(text: string, projectRoot: string): string {
  const config = parseJsonObject(text);
  const mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
  mcpServers['code-memory'] = {
    command: 'code-memory',
    args: ['serve', '--watch'],
    cwd: projectRoot,
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
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
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
