import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROJECT_MARKER_START = '<!-- CODE_MEMORY_PROJECT_CONTEXT_START -->';
const PROJECT_MARKER_END = '<!-- CODE_MEMORY_PROJECT_CONTEXT_END -->';

export interface ProjectOnboardingOptions {
  projectRoot: string;
  dryRun?: boolean;
  writeContext?: boolean;
  writeSkills?: boolean;
  writeHooks?: boolean;
}

export interface ProjectOnboardingChange {
  filePath: string;
  action: 'create' | 'update' | 'noop';
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
    changes.push(...buildHookChanges(options.projectRoot));
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

function buildProjectContextBlock(projectRoot: string): string {
  return [
    PROJECT_MARKER_START,
    '# Code Memory - AI Context Workflow',
    '',
    'This repository is prepared for Code Memory. Use it as the first local project map before broad file reads.',
    '',
    '## Recommended Tool Path',
    '',
    'Default chain: plan_context -> get_context_pack/search_code -> search_symbols -> impact_analysis -> get_related_tests.',
    '',
    '1. `plan_context` - classify the task, check index/vector/ledger readiness, and choose retrieval routes.',
    '2. `get_context_pack` or `search_code` - retrieve bounded evidence for the current task.',
    '3. `search_symbols` then `find_definition` / `find_references` - drill into a specific symbol.',
    '4. `impact_analysis` - run before editing shared symbols or files.',
    '5. `get_related_tests` - identify narrow validation targets.',
    '6. `remember_project_fact` - save durable architecture decisions or bug root causes.',
    '',
    '## CLI Mirrors',
    '',
    '- `code-memory setup --project .` initializes, indexes, writes MCP config, and installs this context.',
    '- `code-memory bootstrap --project .` safely initializes or refreshes the local index.',
    '- `code-memory query "search terms" --project . --json` mirrors indexed search outside MCP.',
    '- `code-memory status --json` and `code-memory doctor` verify index health.',
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

function buildExploringSkill(): string {
  return [
    '# Code Memory Exploring',
    '',
    'Use when you need to understand architecture, feature flow, ownership, or unfamiliar code.',
    '',
    '## Tool Order',
    '',
    '1. `plan_context({ query })`',
    '2. `get_context_pack({ query, tokenBudget, avoidRepeated: true })`',
    '3. `search_symbols` for named functions/classes/types',
    '4. `find_definition` for exact source locations',
    '5. `get_call_graph` or `get_dependency_graph` when relationships matter',
    '',
    '## Checklist',
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
    'Use when investigating a failing behavior, regression, stale index, or suspicious result.',
    '',
    '## Tool Order',
    '',
    '1. `plan_context({ query, intent: "debug" })`',
    '2. `get_context_pack` for likely files and prior memories',
    '3. `search_code` for error text, route names, or failing symbols',
    '4. `find_references` / `get_call_graph` to trace callers and callees',
    '5. `get_related_tests` for narrow verification',
    '',
    '## Risk Checks',
    '',
    '- If stale diagnostics appear, run `code-memory sync --project .` or `code-memory index --project . --full`.',
    '- If evidence is contradictory, prefer current file contents and refresh the index.',
    '- Record confirmed root causes with `remember_project_fact`.',
  ].join('\n') + '\n';
}

function buildImpactSkill(): string {
  return [
    '# Code Memory Impact Analysis',
    '',
    'Use before editing a shared symbol, route, exported API, config loader, parser, or index lifecycle code.',
    '',
    '## Tool Order',
    '',
    '1. `search_symbols` or `find_definition` to identify the exact target.',
    '2. `impact_analysis({ target })` before editing.',
    '3. `get_related_tests` for validation targets.',
    '4. After edits, rerun targeted tests and inspect affected files.',
    '',
    '## Risk Judgment',
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
    'Use when renaming, extracting, splitting modules, or changing public contracts.',
    '',
    '## Tool Order',
    '',
    '1. `plan_context({ query, intent: "refactor" })`',
    '2. `search_symbols` and `find_references` for all known uses.',
    '3. `impact_analysis` before changing the target.',
    '4. `get_related_tests` and repository-native tests after edits.',
    '',
    '## Guardrails',
    '',
    '- Do not use blind find-and-replace for exported symbols.',
    '- Keep response shapes stable unless tests cover the contract change.',
    '- Save migration decisions with `remember_project_fact`.',
  ].join('\n') + '\n';
}

function buildHookChanges(projectRoot: string): ProjectOnboardingChange[] {
  const hookPath = join(projectRoot, '.claude', 'hooks', 'code-memory-pretooluse.mjs');
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const scriptBefore = readText(hookPath);
  const scriptAfter = buildPreToolUseHookScript();
  const settingsBefore = readText(settingsPath);
  const settingsAfter = applyHookSettings(settingsBefore);

  return [
    toChange(hookPath, scriptBefore, scriptAfter),
    toChange(settingsPath, settingsBefore, settingsAfter),
  ];
}

function buildPreToolUseHookScript(): string {
  return [
    '#!/usr/bin/env node',
    "import { spawnSync } from 'node:child_process';",
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
    "  'A broad search tool is about to run. Prefer indexed project evidence first when relevant.',",
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
    "  const args = ['-y', 'code-memory@latest', 'query', query, '--project', projectRoot, '--limit', '5', '--json'];",
    "  const run = spawnSync('npx', args, { encoding: 'utf-8', timeout: 15000, shell: process.platform === 'win32' });",
    '  if (run.status !== 0 || !run.stdout.trim()) return null;',
    '  try {',
    '    const parsed = JSON.parse(run.stdout);',
    '    if (!Array.isArray(parsed) || parsed.length === 0) return null;',
    '    return parsed.slice(0, 5).map((item) => {',
    "      const name = item.name || '(unknown)';",
    "      const kind = item.kind || 'item';",
    "      const filePath = item.filePath || '(unknown file)';",
    "      return '- ' + name + ' (' + kind + ') - ' + filePath;",
    "    }).join('\\n');",
    '  } catch {',
    '    return run.stdout.slice(0, 2000);',
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

function isCodeMemoryHook(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hooks = Array.isArray(value.hooks) ? value.hooks : [];
  return hooks.some((hook) => isRecord(hook) &&
    String(hook.command || '') === 'node' &&
    Array.isArray(hook.args) &&
    hook.args.some((arg) => String(arg).includes('code-memory-pretooluse.mjs')));
}

function applyManagedBlock(text: string, block: string, start: string, end: string): string {
  const cleaned = removeManagedBlock(text, start, end).trimEnd();
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

function toChange(filePath: string, before: string, after: string): ProjectOnboardingChange {
  return {
    filePath,
    action: before ? (before === after ? 'noop' : 'update') : 'create',
    changed: before !== after,
    before,
    after,
  };
}

function readText(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
}

function writeChange(change: ProjectOnboardingChange): void {
  if (!change.changed) return;
  mkdirSync(dirname(change.filePath), { recursive: true });
  writeFileSync(change.filePath, change.after, 'utf-8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
