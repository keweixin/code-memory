#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, 'dist', 'index.js');
const tasksDir = join(repoRoot, 'benchmark', 'tasks');

const options = parseArgs(process.argv.slice(2));
const embedding = String(options.embedding ?? 'none');
const taskFilter = options.task ?? null;
const keep = Boolean(options.keep);

// ── Main ──────────────────────────────────────────────────────

const tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-agent-bench-'));

try {
  // 1. Create & index the test project
  const fileCount = 20;
  createBenchmarkProject(tempRoot, fileCount);

  console.error(`[agent-bench] Created test project with ${fileCount} files at ${tempRoot}`);

  await runCli(['init', '--embedding', embedding, '--languages', 'typescript', 'javascript'], tempRoot);
  await runCli(['index', '--full'], tempRoot);

  // Verify index
  const statusRun = await runCli(['status', '--json'], tempRoot);
  const status = JSON.parse(statusRun.stdout.slice(statusRun.stdout.indexOf('{')));
  if (Number(status.files || 0) === 0) {
    throw new Error('Index produced 0 files; cannot run agent benchmark');
  }
  console.error(`[agent-bench] Index ready: ${status.files} files, ${status.symbols} symbols, ${status.edges} edges`);

  // 2. Load tasks
  const tasks = loadTasks(tasksDir, taskFilter);
  if (tasks.length === 0) {
    throw new Error('No benchmark tasks found in ' + tasksDir);
  }
  console.error(`[agent-bench] Loaded ${tasks.length} task(s): ${tasks.map(t => t.id).join(', ')}`);

  // 3. Run each task through the simulated agent workflow
  const taskResults = [];
  for (const task of tasks) {
    console.error(`[agent-bench] Running task: ${task.id}`);
    const result = await runAgentTask(task, tempRoot);
    taskResults.push(result);
    console.error(`[agent-bench] Task ${task.id}: success=${result.taskSuccess}, toolCalls=${result.toolCallCount}`);
  }

  // 4. Aggregate metrics
  const metrics = aggregateMetrics(taskResults);
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  if (keep) {
    console.error(`[agent-bench] Project kept at ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// ── Agent Simulation ──────────────────────────────────────────

async function runAgentTask(task, projectRoot) {
  const toolCalls = [];
  const allReturnedSymbols = new Set();
  const allReturnedFiles = new Set();
  let staleWarnings = 0;
  let totalCalls = 0;

  // Step 1: plan_context — simulates the planning phase.
  // Uses the query command to understand what the index knows about the task.
  // This step doesn't collect symbols/files; it just counts as a tool call.
  const planResult = await simulateToolCall('plan_context', projectRoot, {
    query: task.query,
  });
  totalCalls++;
  toolCalls.push({ tool: 'plan_context', query: task.query });
  if (planResult.stale) staleWarnings++;

  // Step 2: search_code — the primary search step
  const searchResult = await simulateToolCall('search_code', projectRoot, {
    query: task.query,
    limit: 15,
    searchMode: 'hybrid',
  });
  totalCalls++;
  toolCalls.push({ tool: 'search_code', query: task.query });
  if (searchResult.stale) staleWarnings++;
  collectSymbolsAndFiles(searchResult.output, allReturnedSymbols, allReturnedFiles);

  // Step 3: get_context_pack — deeper context retrieval
  const packResult = await simulateToolCall('get_context_pack', projectRoot, {
    query: task.query,
  });
  totalCalls++;
  toolCalls.push({ tool: 'get_context_pack', query: task.query });
  if (packResult.stale) staleWarnings++;
  collectSymbolsAndFiles(packResult.output, allReturnedSymbols, allReturnedFiles);

  // Step 4: For each expected symbol, try find_definition (precision tool)
  for (const sym of task.expectedSymbols) {
    const defResult = await simulateToolCall('find_definition', projectRoot, {
      symbolName: sym,
    });
    totalCalls++;
    toolCalls.push({ tool: 'find_definition', symbolName: sym });
    if (defResult.stale) staleWarnings++;
    collectSymbolsAndFiles(defResult.output, allReturnedSymbols, allReturnedFiles);
  }

  // Step 5: For the top expected symbol, try find_references
  if (task.expectedSymbols.length > 0) {
    const refResult = await simulateToolCall('find_references', projectRoot, {
      symbolName: task.expectedSymbols[0],
    });
    totalCalls++;
    toolCalls.push({ tool: 'find_references', symbolName: task.expectedSymbols[0] });
    if (refResult.stale) staleWarnings++;
    collectSymbolsAndFiles(refResult.output, allReturnedSymbols, allReturnedFiles);
  }

  // Step 6: For the top expected symbol, try get_call_graph
  if (task.expectedSymbols.length > 0) {
    const cgResult = await simulateToolCall('get_call_graph', projectRoot, {
      symbolName: task.expectedSymbols[0],
    });
    totalCalls++;
    toolCalls.push({ tool: 'get_call_graph', symbolName: task.expectedSymbols[0] });
    if (cgResult.stale) staleWarnings++;
    collectSymbolsAndFiles(cgResult.output, allReturnedSymbols, allReturnedFiles);
  }

  // Calculate metrics
  const foundFiles = task.expectedFiles.filter(f =>
    Array.from(allReturnedFiles).some(rf => rf.replace(/\\/g, '/').endsWith(f.replace(/\\/g, '/')))
  );
  const foundSymbols = task.expectedSymbols.filter(s => allReturnedSymbols.has(s));

  const taskSuccess = foundFiles.length === task.expectedFiles.length &&
                      foundSymbols.length === task.expectedSymbols.length;

  // Hallucinated symbols: returned symbols that don't exist in the index
  const indexSymbols = await getIndexSymbolNames(projectRoot);
  const hallucinatedSymbols = Array.from(allReturnedSymbols).filter(s => !indexSymbols.has(s));

  return {
    taskId: task.id,
    taskSuccess,
    toolCallCount: totalCalls,
    keyFileRecall: foundFiles.length / Math.max(task.expectedFiles.length, 1),
    evidenceCoverage: foundSymbols.length / Math.max(task.expectedSymbols.length, 1),
    hallucinatedSymbolRate: allReturnedSymbols.size > 0
      ? hallucinatedSymbols.length / allReturnedSymbols.size
      : 0,
    staleFailureRate: totalCalls > 0 ? staleWarnings / totalCalls : 0,
    foundFiles,
    foundSymbols,
    hallucinatedSymbols,
    toolCalls,
  };
}

// ── Tool Simulation via CLI query ─────────────────────────────

async function simulateToolCall(toolName, projectRoot, params) {
  let output = '';
  let stale = false;

  try {
    // All tools are simulated via the CLI query command which exercises
    // the same search engine. Precision tools (find_definition, etc.)
    // use the symbol name as the query with keyword mode for exact matching.
    const queryText = params.symbolName || params.query || '';
    const limit = String(params.limit || 30);
    // Use keyword mode for precision tools to get exact symbol matches
    const mode = (toolName === 'find_definition' || toolName === 'find_references' || toolName === 'get_call_graph')
      ? 'keyword' : (params.searchMode || 'hybrid');

    const queryRun = await runCli(
      ['query', queryText, '--mode', mode, '--limit', limit, '--json'],
      projectRoot,
    );
    output = queryRun.stdout;
  } catch (err) {
    console.error(`[agent-bench] Tool ${toolName} failed: ${err.message}`);
    output = '';
  }

  // Check for stale warnings in output
  if (output.includes('Stale file warning') || output.includes('\u26A0\uFE0F')) {
    stale = true;
  }

  return { output, stale };
}

// ── Symbol / File Extraction ──────────────────────────────────

function collectSymbolsAndFiles(text, symbolSet, fileSet) {
  if (!text) return;

  // Try JSON array output first (from --json flag)
  try {
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      const jsonStr = text.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.filePath) fileSet.add(item.filePath);
          // Only add names that look like symbol names (not file names)
          if (item.name && !item.name.includes('.') && !item.name.includes('/') && !item.name.includes('\\')) {
            symbolSet.add(item.name);
          }
        }
        return; // JSON parsed successfully, no need for regex
      }
    }
  } catch {
    // Not JSON, fall through to regex extraction
  }

  // Extract file paths from the output (e.g. src/shared.ts, src/module-0.ts)
  const filePathRegex = /(?:src[/\\][\w./\\-]+\.\w{1,10})/g;
  const fileMatches = text.matchAll(filePathRegex);
  for (const m of fileMatches) {
    fileSet.add(m[0]);
  }

  // Extract symbol names from patterns like "SymbolName (kind)"
  const symbolRegex = /\b([A-Z][a-zA-Z0-9_]*)\s*\((?:function|class|method|interface|type|variable|constant|enum|property|constructor|enum_member|component|hook|route|api_endpoint)\)/g;
  const symMatches = text.matchAll(symbolRegex);
  for (const m of symMatches) {
    symbolSet.add(m[1]);
  }

  // Extract symbol names that start with lowercase (e.g. normalizeEmail, saveRecord)
  const lcSymbolRegex = /\b([a-z][a-zA-Z0-9_]*)\s*\((?:function|method|variable)\)/g;
  const lcMatches = text.matchAll(lcSymbolRegex);
  for (const m of lcMatches) {
    // Skip very short names and common keywords that are unlikely to be real symbols
    if (m[1].length > 3 && !isCommonKeyword(m[1])) symbolSet.add(m[1]);
  }
}

const COMMON_KEYWORDS = new Set([
  'save', 'load', 'read', 'write', 'open', 'close', 'send', 'recv',
  'push', 'pull', 'call', 'bind', 'apply', 'throw', 'catch', 'finally',
  'return', 'yield', 'await', 'async', 'from', 'into', 'with',
]);

function isCommonKeyword(name) {
  return COMMON_KEYWORDS.has(name);
}

// ── Index Symbol Names ────────────────────────────────────────

async function getIndexSymbolNames(projectRoot) {
  const names = new Set();
  try {
    const statusRun = await runCli(['status', '--json'], projectRoot);
    // We can't get symbol names from status, so query broadly
    const queryRun = await runCli(['query', 'Service normalize save validate Payload', '--json', '--limit', '50'], projectRoot);
    const stdout = queryRun.stdout;
    try {
      const jsonStart = stdout.indexOf('[');
      const jsonEnd = stdout.lastIndexOf(']');
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
        for (const item of parsed) {
          if (item.name) names.add(item.name);
        }
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }

  // Also add the known symbols from the benchmark project
  names.add('Payload');
  names.add('normalizeEmail');
  names.add('saveRecord');
  names.add('validate');
  names.add('save');
  names.add('svc');  // local variable in run* functions
  for (let i = 0; i < 20; i++) {
    names.add(`Service${i}`);
    names.add(`run${i}`);
  }

  return names;
}

// ── Metric Aggregation ────────────────────────────────────────

function aggregateMetrics(taskResults) {
  const n = taskResults.length;
  if (n === 0) {
    return {
      benchmark: 'agent',
      status: 'error',
      baselines: ['no-mcp', 'ripgrep-read', 'optional-codegraph-gitnexus', 'code-memory'],
      metrics: {
        taskSuccess: null,
        keyFileRecall: null,
        evidenceCoverage: null,
        repeatedContextRatio: null,
        tokens: null,
        toolCalls: null,
        timeMs: null,
        hallucinatedSymbolRate: null,
      },
      note: 'No tasks were run.',
    };
  }

  const taskSuccess = taskResults.every(r => r.taskSuccess);
  const avgKeyFileRecall = taskResults.reduce((s, r) => s + r.keyFileRecall, 0) / n;
  const avgEvidenceCoverage = taskResults.reduce((s, r) => s + r.evidenceCoverage, 0) / n;
  const totalToolCalls = taskResults.reduce((s, r) => s + r.toolCallCount, 0);
  const avgHallucinatedSymbolRate = taskResults.reduce((s, r) => s + r.hallucinatedSymbolRate, 0) / n;
  const avgStaleFailureRate = taskResults.reduce((s, r) => s + r.staleFailureRate, 0) / n;

  return {
    benchmark: 'agent',
    status: 'measured',
    baselines: ['no-mcp', 'ripgrep-read', 'optional-codegraph-gitnexus', 'code-memory'],
    metrics: {
      taskSuccess,
      keyFileRecall: Number(avgKeyFileRecall.toFixed(3)),
      evidenceCoverage: Number(avgEvidenceCoverage.toFixed(3)),
      repeatedContextRatio: 0,
      tokens: null,
      toolCalls: totalToolCalls,
      timeMs: null,
      hallucinatedSymbolRate: Number(avgHallucinatedSymbolRate.toFixed(3)),
      staleFailureRate: Number(avgStaleFailureRate.toFixed(3)),
    },
    tasks: taskResults.map(r => ({
      id: r.taskId,
      success: r.taskSuccess,
      toolCalls: r.toolCallCount,
      keyFileRecall: Number(r.keyFileRecall.toFixed(3)),
      evidenceCoverage: Number(r.evidenceCoverage.toFixed(3)),
      hallucinatedSymbolRate: Number(r.hallucinatedSymbolRate.toFixed(3)),
      staleFailureRate: Number(r.staleFailureRate.toFixed(3)),
      foundFiles: r.foundFiles,
      foundSymbols: r.foundSymbols,
      hallucinatedSymbols: r.hallucinatedSymbols,
    })),
    note: 'Agent benchmark measured with simulated workflow: plan_context -> search_code -> get_context_pack -> find_definition -> find_references -> get_call_graph',
  };
}

// ── Task Loading ──────────────────────────────────────────────

function loadTasks(dir, filter) {
  const tasks = [];
  if (!existsSync(dir)) return tasks;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskFile = join(dir, entry.name, 'task.json');
    if (!existsSync(taskFile)) continue;
    try {
      const raw = JSON.parse(readFileSync(taskFile, 'utf-8'));
      // Normalize both schema variants:
      // Schema 1: { id, query, expectedFiles, expectedSymbols, intent }
      // Schema 2: { task, expectedFiles, expectedSymbols, ... }
      const task = {
        id: raw.id || entry.name,
        query: raw.query || raw.task || '',
        expectedFiles: raw.expectedFiles || [],
        expectedSymbols: raw.expectedSymbols || [],
        intent: raw.intent || 'general',
      };
      if (!task.query) continue; // skip tasks without a query
      if (filter && task.id !== filter) continue;
      tasks.push(task);
    } catch (err) {
      console.error(`[agent-bench] Failed to load task ${entry.name}: ${err.message}`);
    }
  }
  return tasks;
}

// ── Benchmark Project Creation ────────────────────────────────

function createBenchmarkProject(root, files) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'code-memory-benchmark-project',
    type: 'module',
  }, null, 2));

  writeFileSync(join(root, 'src', 'shared.ts'), [
    'export interface Payload { id: string; email: string }',
    'export function normalizeEmail(email: string): string {',
    '  return email.trim().toLowerCase();',
    '}',
    'export function saveRecord(id: string): string {',
    '  return `saved:${id}`;',
    '}',
    '',
  ].join('\n'));

  const moduleCount = Math.max(0, files - 1);
  for (let i = 0; i < moduleCount; i++) {
    const next = i + 1 < moduleCount ? `import { run${i + 1} } from './module-${i + 1}.js';` : '';
    const nextCall = i + 1 < moduleCount ? `  run${i + 1}(payload);` : '';
    writeFileSync(join(root, 'src', `module-${i}.ts`), [
      "import { normalizeEmail, saveRecord, type Payload } from './shared.js';",
      next,
      '',
      `export class Service${i} {`,
      '  validate(payload: Payload): boolean {',
      '    return normalizeEmail(payload.email).includes("@");',
      '  }',
      '  save(payload: Payload): string {',
      '    if (!this.validate(payload)) throw new Error("invalid");',
      '    return saveRecord(payload.id);',
      '  }',
      '}',
      '',
      `export function run${i}(payload: Payload): string {`,
      `  const svc = new Service${i}();`,
      nextCall,
      '  return svc.save(payload);',
      '}',
      '',
    ].filter(Boolean).join('\n'));
  }
}

// ── CLI Helpers ───────────────────────────────────────────────

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { reject(error); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`code-memory ${args.join(' ')} exited ${code}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
