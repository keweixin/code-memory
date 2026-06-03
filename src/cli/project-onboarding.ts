import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeName } from './agent-config.js';

const PROJECT_MARKER_START = '<!-- CODE_MEMORY_CONTEXT_START -->';
const PROJECT_MARKER_END = '<!-- CODE_MEMORY_CONTEXT_END -->';
const LEGACY_PROJECT_MARKER_START = '<!-- CODE_MEMORY_PROJECT_CONTEXT_START -->';
const LEGACY_PROJECT_MARKER_END = '<!-- CODE_MEMORY_PROJECT_CONTEXT_END -->';
const HOOK_TIMEOUT_MS = 5000;
const HOOK_MAX_OUTPUT_CHARS = 4000;

export interface ProjectOnboardingOptions {
  projectRoot: string;
  dryRun?: boolean;
  writeContext?: boolean;
  writeSkills?: boolean;
  writeHooks?: boolean;
  runtime?: RuntimeName;
}

export interface ProjectOnboardingChange {
  filePath: string;
  action: 'create' | 'update' | 'remove' | 'noop';
  changed: boolean;
  before: string;
  after: string;
}

export function setupProjectOnboarding(options: ProjectOnboardingOptions): ProjectOnboardingChange[] {
  const changes: ProjectOnboardingChange[] = [];
  if (options.writeContext !== false) {
    changes.push(...buildContextChanges(options.projectRoot));
  }
  if (options.writeSkills !== false) {
    changes.push(...buildSkillChanges(options.projectRoot));
  }
  if (options.writeHooks !== false) {
    changes.push(...buildHookChanges(options.projectRoot, options.runtime || 'npx'));
  }

  if (!options.dryRun) {
    for (const change of changes) writeChange(change);
  }

  return changes;
}

export function uninstallProjectOnboarding(options: ProjectOnboardingOptions): ProjectOnboardingChange[] {
  const changes: ProjectOnboardingChange[] = [];
  if (options.writeContext !== false) {
    changes.push(...buildContextRemovalChanges(options.projectRoot));
  }
  if (options.writeSkills !== false) {
    changes.push(...buildSkillRemovalChanges(options.projectRoot));
  }
  if (options.writeHooks !== false) {
    changes.push(...buildHookRemovalChanges(options.projectRoot));
  }

  if (!options.dryRun) {
    for (const change of changes) writeChange(change);
  }

  return changes;
}

export function formatProjectOnboardingChanges(
  changes: ProjectOnboardingChange[],
  dryRun: boolean,
): string {
  const lines = [
    dryRun ? 'Code Memory project onboarding dry run' : 'Code Memory project onboarding',
    '',
  ];
  for (const change of changes) {
    lines.push(`${change.changed ? 'CHANGE' : 'NOOP'} ${change.action}: ${change.filePath}`);
  }
  return lines.join('\n');
}

function buildContextChanges(projectRoot: string): ProjectOnboardingChange[] {
  const block = buildProjectContextBlock(projectRoot);
  return ['AGENTS.md', 'CLAUDE.md'].map((fileName) => {
    const filePath = join(projectRoot, fileName);
    const before = readText(filePath);
    const after = applyManagedBlock(before, block, PROJECT_MARKER_START, PROJECT_MARKER_END);
    return toChange(filePath, before, after);
  });
}

function buildContextRemovalChanges(projectRoot: string): ProjectOnboardingChange[] {
  return ['AGENTS.md', 'CLAUDE.md'].map((fileName) => {
    const filePath = join(projectRoot, fileName);
    const before = readText(filePath);
    const withoutLegacy = removeManagedBlock(before, LEGACY_PROJECT_MARKER_START, LEGACY_PROJECT_MARKER_END);
    const cleaned = removeManagedBlock(withoutLegacy, PROJECT_MARKER_START, PROJECT_MARKER_END).trimEnd();
    const after = cleaned ? cleaned + '\n' : '';
    return toChange(filePath, before, after);
  });
}

function buildProjectContextBlock(projectRoot: string): string {
  return [
    PROJECT_MARKER_START,
    '# Code Memory - AI Context Workflow',
    '',
    'This repository is prepared for Code Memory. Use it as a local project map before broad file reads.',
    '',
    '## Recommended Tool Path',
    '',
    'Default chain: plan_context -> get_context_pack/search_code -> search_symbols -> find_definition/find_references -> impact_analysis -> get_related_tests.',
    '',
    '1. `plan_context` - classify the task, check index/vector/ledger readiness, and choose retrieval routes.',
    '2. `get_context_pack` or `search_code` - retrieve bounded evidence for the current task.',
    '3. `search_symbols` then `find_definition` / `find_references` - drill into a specific symbol.',
    '4. `impact_analysis` - run before editing shared symbols, public contracts, or startup/index lifecycle code.',
    '5. `get_related_tests` - identify narrow validation targets.',
    '6. `remember_project_fact` - save durable architecture decisions or bug root causes.',
    '',
    '## CLI Mirrors And Health',
    '',
    '- `code-memory setup --project .` initializes, indexes, writes MCP config, and installs this context.',
    '- `code-memory bootstrap --project .` safely initializes or refreshes the local index.',
    '- `code-memory query "search terms" --project . --json` mirrors indexed search outside MCP.',
    '- `code-memory status --project . --json` and `code-memory doctor --project .` verify index health.',
    '',
    '## Project Root',
    '',
    projectRoot,
    PROJECT_MARKER_END,
  ].join('\n');
}

function buildSkillChanges(projectRoot: string): ProjectOnboardingChange[] {
  const skillRoot = join(projectRoot, '.claude', 'skills', 'code-memory');
  const skills: Array<[string, string]> = [
    ['code-memory-exploring.md', buildExploringSkill()],
    ['code-memory-debugging.md', buildDebuggingSkill()],
    ['code-memory-impact-analysis.md', buildImpactSkill()],
    ['code-memory-refactoring.md', buildRefactoringSkill()],
  ];

  return skills.map(([fileName, content]) => {
    const filePath = join(skillRoot, fileName);
    const before = readText(filePath);
    return toChange(filePath, before, content);
  });
}

function buildSkillRemovalChanges(projectRoot: string): ProjectOnboardingChange[] {
  const skillRoot = join(projectRoot, '.claude', 'skills', 'code-memory');
  return [toRemoveChange(skillRoot, existsSync(skillRoot))];
}

function buildExploringSkill(): string {
  return [
    '# Code Memory Exploring',
    '',
    '## When to use',
    '',
    'Understand architecture, feature flow, ownership, or unfamiliar code.',
    '',
    '## Tool Order',
    '',
    '1. `plan_context({ query })`',
    '2. `get_context_pack({ query, tokenBudget, avoidRepeated: true })`',
    '3. `search_symbols` for named functions/classes/types',
    '4. `find_definition` for exact source locations',
    '5. `get_call_graph` or `get_dependency_graph` when relationships matter',
    '',
    '## Done checklist',
    '',
    '- Prefer indexed evidence before broad grep or recursive reads.',
    '- Cite files and symbols from tool output before making claims.',
    '- Save reusable findings with `remember_project_fact`.',
  ].join('\n') + '\n';
}

function buildDebuggingSkill(): string {
  return [
    '# Code Memory Debugging',
    '',
    '## When to use',
    '',
    'Investigate failing behavior, regression, stale index, or suspicious tool output.',
    '',
    '## Tool Order',
    '',
    '1. `plan_context({ query, intent: "debug" })`',
    '2. `get_context_pack` for likely files and prior memories',
    '3. `search_code` for error text, route names, or failing symbols',
    '4. `find_references` / `get_call_graph` to trace callers and callees',
    '5. `get_related_tests` for narrow verification',
    '',
    '## Done checklist',
    '',
    '- If stale diagnostics appear, run `code-memory sync --project .` or `code-memory bootstrap --project .`.',
    '- If evidence is contradictory, prefer current file contents and refresh the index.',
    '- Record confirmed root causes with `remember_project_fact`.',
  ].join('\n') + '\n';
}

function buildImpactSkill(): string {
  return [
    '# Code Memory Impact Analysis',
    '',
    '## When to use',
    '',
    'Before editing a shared symbol, route, exported API, config loader, parser, or index lifecycle code.',
    '',
    '## Tool Order',
    '',
    '1. `search_symbols` or `find_definition` to identify the exact target.',
    '2. `impact_analysis({ target })` before editing.',
    '3. `get_related_tests` for validation targets.',
    '4. After edits, rerun targeted tests and inspect affected files.',
    '',
    '## Done checklist',
    '',
    '- Low: isolated file or symbol with few references.',
    '- Medium: multiple callers, generated outputs, or CLI/MCP behavior.',
    '- High: index lifecycle, storage schema, public tool response shape, or startup path.',
  ].join('\n') + '\n';
}

function buildRefactoringSkill(): string {
  return [
    '# Code Memory Refactoring',
    '',
    '## When to use',
    '',
    'Rename, extract, split modules, or change public contracts.',
    '',
    '## Tool Order',
    '',
    '1. `plan_context({ query, intent: "refactor" })`',
    '2. `search_symbols` and `find_references` for all known uses.',
    '3. `impact_analysis` before changing the target.',
    '4. `get_related_tests` and repository-native tests after edits.',
    '',
    '## Done checklist',
    '',
    '- Do not use blind find-and-replace for exported symbols.',
    '- Keep response shapes stable unless tests cover the contract change.',
    '- Save migration decisions with `remember_project_fact`.',
  ].join('\n') + '\n';
}

function buildHookChanges(projectRoot: string, runtime: RuntimeName): ProjectOnboardingChange[] {
  const hookPath = join(projectRoot, '.claude', 'hooks', 'code-memory-pretooluse.mjs');
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const scriptBefore = readText(hookPath);
  const scriptAfter = buildPreToolUseHookScript(runtime);
  const settingsBefore = readText(settingsPath);
  const settingsAfter = applyHookSettings(settingsBefore);

  return [
    toChange(hookPath, scriptBefore, scriptAfter),
    toChange(settingsPath, settingsBefore, settingsAfter),
  ];
}

function buildHookRemovalChanges(projectRoot: string): ProjectOnboardingChange[] {
  const hookPath = join(projectRoot, '.claude', 'hooks', 'code-memory-pretooluse.mjs');
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const settingsBefore = readText(settingsPath);
  const settingsAfter = removeHookSettings(settingsBefore);
  const settingsChange = settingsAfter === '' && settingsBefore
    ? toRemoveChange(settingsPath, true)
    : toChange(settingsPath, settingsBefore, settingsAfter);

  return [
    toRemoveChange(hookPath, existsSync(hookPath)),
    settingsChange,
  ];
}

function buildPreToolUseHookScript(runtime: RuntimeName): string {
  const launch = getHookLaunchSpec(runtime);
  return [
    '#!/usr/bin/env node',
    "import { spawnSync } from 'node:child_process';",
    '',
    'const HOOK_TIMEOUT_MS = ' + HOOK_TIMEOUT_MS + ';',
    'const MAX_OUTPUT_CHARS = ' + HOOK_MAX_OUTPUT_CHARS + ';',
    'const CODE_MEMORY_COMMAND = ' + JSON.stringify(launch.command) + ';',
    'const CODE_MEMORY_BASE_ARGS = ' + JSON.stringify(launch.args) + ';',
    '',
    "if (process.env.CODE_MEMORY_HOOK_DISABLED === '1' || process.env.CODE_MEMORY_PRETOOLUSE === '1') process.exit(0);",
    '',
    'const input = await readStdin();',
    'const event = safeParse(input);',
    'const query = extractQuery(event);',
    '',
    'if (!query) process.exit(0);',
    '',
    'const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();',
    'const result = runCodeMemoryQuery(query, projectRoot);',
    'if (!result) process.exit(0);',
    '',
    'const additionalContext = [',
    "  '[Code Memory PreToolUse context]',",
    "  'A broad search tool is about to run. Indexed project evidence may help when relevant.',",
    "  'Query: ' + query,",
    "  'Top indexed results:',",
    '  result,',
    "  'After this: use plan_context or get_context_pack for bounded context before editing.'",
    "].join('\\n');",
    '',
    'process.stdout.write(JSON.stringify({',
    '  hookSpecificOutput: {',
    "    hookEventName: 'PreToolUse',",
    '    additionalContext,',
    '  },',
    '}));',
    '',
    'function runCodeMemoryQuery(query, projectRoot) {',
    "  const args = [...CODE_MEMORY_BASE_ARGS, 'query', query, '--project', projectRoot, '--limit', '5', '--json'];",
    "  const run = spawnSync(CODE_MEMORY_COMMAND, args, {",
    "    encoding: 'utf-8',",
    '    timeout: HOOK_TIMEOUT_MS,',
    "    shell: process.platform === 'win32',",
    "    env: { ...process.env, CODE_MEMORY_PRETOOLUSE: '1' },",
    '  });',
    '  if (run.status !== 0 || !run.stdout.trim()) return null;',
    '  try {',
    '    const parsed = JSON.parse(run.stdout);',
    '    if (!Array.isArray(parsed) || parsed.length === 0) return null;',
    '    const formatted = parsed.slice(0, 5).map((item) => {',
    "      const name = item.name || '(unknown)';",
    "      const kind = item.kind || 'item';",
    "      const filePath = item.filePath || '(unknown file)';",
    "      return '- ' + name + ' (' + kind + ') - ' + filePath;",
    "    }).join('\\n');",
    '    return formatted.slice(0, MAX_OUTPUT_CHARS);',
    '  } catch {',
    '    return run.stdout.slice(0, MAX_OUTPUT_CHARS);',
    '  }',
    '}',
    '',
    'function extractQuery(event) {',
    "  if (!event || event.hook_event_name !== 'PreToolUse') return '';",
    '  const toolName = String(event.tool_name || "");',
    '  const input = event.tool_input || {};',
    "  if (toolName === 'Grep') return String(input.pattern || input.query || '').trim();",
    "  if (toolName === 'Glob') return String(input.pattern || '').trim();",
    "  if (toolName !== 'Bash') return '';",
    "  const command = String(input.command || '');",
    "  if (!/\\b(rg|grep|findstr)\\b/i.test(command)) return '';",
    "  const quoted = command.match(/['\\\"]([^'\\\"]{2,120})['\\\"]/);",
    '  if (quoted) return quoted[1].trim();',
    "  const parts = command.split(/\\s+/).filter(Boolean);",
    "  return parts.find((part) => !part.startsWith('-') && !/^(rg|grep|findstr|Select-String)$/i.test(part)) || '';",
    '}',
    '',
    'function safeParse(text) {',
    '  try { return JSON.parse(text); } catch { return null; }',
    '}',
    '',
    'function readStdin() {',
    '  return new Promise((resolve) => {',
    "    let data = '';",
    "    process.stdin.setEncoding('utf8');",
    "    process.stdin.on('data', (chunk) => { data += chunk; });",
    "    process.stdin.on('end', () => resolve(data));",
    '  });',
    '}',
  ].join('\n') + '\n';
}

function getHookLaunchSpec(runtime: RuntimeName): { command: string; args: string[] } {
  if (runtime === 'global') return { command: 'code-memory', args: [] };
  if (runtime === 'local') {
    const distIndexPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'index.js');
    return { command: 'node', args: [distIndexPath] };
  }
  return { command: 'npx', args: ['-y', 'code-memory@latest'] };
}

function applyHookSettings(text: string): string {
  const config = parseJsonObject(text);
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const entry = {
    matcher: 'Bash|Grep|Glob',
    hooks: [{
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/code-memory-pretooluse.mjs'],
      timeout: 20,
    }],
  };
  const filtered = preToolUse.filter((item) => !isCodeMemoryHook(item));
  hooks.PreToolUse = [...filtered, entry];
  config.hooks = hooks;
  return JSON.stringify(config, null, 2) + '\n';
}

function removeHookSettings(text: string): string {
  if (!text.trim()) return '';
  const config = tryParseJsonObject(text);
  if (!config || !isRecord(config.hooks)) return text;

  const hooks = { ...config.hooks };
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const filtered = preToolUse.filter((item) => !isCodeMemoryHook(item));
  if (filtered.length === preToolUse.length) return text;

  if (filtered.length > 0) {
    hooks.PreToolUse = filtered;
  } else {
    delete hooks.PreToolUse;
  }
  if (Object.keys(hooks).length > 0) {
    config.hooks = hooks;
  } else {
    delete config.hooks;
  }

  return Object.keys(config).length > 0
    ? JSON.stringify(config, null, 2) + '\n'
    : '';
}

function isCodeMemoryHook(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hooks = Array.isArray(value.hooks) ? value.hooks : [];
  return hooks.some((hook) => isRecord(hook) &&
    String(hook.command || '') === 'node' &&
    Array.isArray(hook.args) &&
    hook.args.some((arg) => String(arg).includes('code-memory-pretooluse.mjs')));
}

function applyManagedBlock(text: string, block: string, start: string, end: string): string {
  const withoutLegacy = removeManagedBlock(text, LEGACY_PROJECT_MARKER_START, LEGACY_PROJECT_MARKER_END);
  const cleaned = removeManagedBlock(withoutLegacy, start, end).trimEnd();
  return (cleaned ? cleaned + '\n\n' : '') + block + '\n';
}

function removeManagedBlock(text: string, start: string, end: string): string {
  const escapedStart = escapeRegExp(start);
  const escapedEnd = escapeRegExp(end);
  return text.replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\s*`, 'g'), '');
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toChange(filePath: string, before: string, after: string): ProjectOnboardingChange {
  return {
    filePath,
    action: before ? (before === after ? 'noop' : 'update') : 'create',
    changed: before !== after,
    before,
    after,
  };
}

function toRemoveChange(filePath: string, exists: boolean): ProjectOnboardingChange {
  return {
    filePath,
    action: exists ? 'remove' : 'noop',
    changed: exists,
    before: exists ? '[managed artifact]' : '',
    after: '',
  };
}

function readText(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
}

function writeChange(change: ProjectOnboardingChange): void {
  if (!change.changed) return;
  if (change.action === 'remove') {
    assertSafeManagedPath(change.filePath);
    rmSync(change.filePath, { recursive: true, force: true });
    return;
  }
  mkdirSync(dirname(change.filePath), { recursive: true });
  writeFileSync(change.filePath, change.after, 'utf-8');
}

function assertSafeManagedPath(filePath: string): void {
  const resolved = resolve(filePath);
  const normalized = resolved.toLowerCase();
  const allowedSegments = [
    `${sep}.claude${sep}skills${sep}code-memory`,
    `${sep}.claude${sep}hooks${sep}code-memory-pretooluse.mjs`,
    `${sep}.claude${sep}settings.json`,
  ];
  if (!allowedSegments.some((segment) => normalized.includes(segment.toLowerCase()))) {
    throw new Error('Refusing to remove unmanaged path: ' + filePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
