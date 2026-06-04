#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, 'dist', 'index.js');

const options = parseArgs(process.argv.slice(2));
const configPath = resolve(repoRoot, String(options.config ?? 'benchmark/real-repos.json'));
const repoFilter = String(options.repo ?? 'all');
const taskFilter = String(options.task ?? 'all');
const embedding = String(options.embedding ?? 'none');
const workers = String(options.workers ?? 'auto');
const limit = String(options.limit ?? '20');
const dryRun = Boolean(options.dryRun);
const keep = Boolean(options.keep);
const failOnThreshold = Boolean(options.failOnThreshold);
const workRoot = options.workDir
  ? resolve(String(options.workDir))
  : mkdtempSync(join(tmpdir(), 'code-memory-real-repos-'));

const startedAt = new Date().toISOString();
const config = loadConfig(configPath);
const selectedRepos = selectRepos(config, repoFilter, taskFilter);

if (selectedRepos.length === 0) {
  throw new Error(`No real repo benchmark targets match repo=${repoFilter} task=${taskFilter}`);
}

if (dryRun) {
  console.log(JSON.stringify({
    benchmark: 'real-repos',
    status: 'configured',
    configPath,
    workRoot,
    repoCount: selectedRepos.length,
    taskCount: selectedRepos.reduce((sum, repo) => sum + repo.tasks.length, 0),
    repos: selectedRepos.map((repo) => ({
      name: repo.name,
      repo: repo.repo,
      commit: repo.commit,
      languageProfile: repo.languageProfile,
      taskIds: repo.tasks.map((task) => task.id),
      minimumMetrics: repo.minimumMetrics,
    })),
  }, null, 2));
  process.exit(0);
}

const failures = [];
const repoResults = [];

try {
  mkdirSync(workRoot, { recursive: true });

  for (const repo of selectedRepos) {
    console.error(`[real-repos] Preparing ${repo.name} at ${repo.commit}`);
    const projectRoot = join(workRoot, repo.name);
    await prepareRepo(repo, projectRoot);

    console.error(`[real-repos] Bootstrapping ${repo.name}`);
    await runCli(['bootstrap', '--project', projectRoot, '--embedding', embedding, '--workers', workers], repoRoot);

    const taskResults = [];
    for (const task of repo.tasks) {
      console.error(`[real-repos] Running ${repo.name}/${task.id}`);
      taskResults.push(await runTask(repo, task, projectRoot));
    }

    const metrics = aggregateTaskMetrics(taskResults);
    const result = {
      name: repo.name,
      repo: repo.repo,
      commit: repo.commit,
      projectRoot,
      taskCount: taskResults.length,
      minimumMetrics: repo.minimumMetrics,
      metrics,
      tasks: taskResults,
    };
    repoResults.push(result);
    checkThresholds(result, failures);
  }

  const metrics = aggregateRepoMetrics(repoResults);
  const output = {
    benchmark: 'real-repos',
    status: failures.length > 0 ? 'failed' : 'measured',
    startedAt,
    completedAt: new Date().toISOString(),
    configPath,
    workRoot,
    embedding,
    workers,
    repoCount: repoResults.length,
    taskCount: repoResults.reduce((sum, repo) => sum + repo.taskCount, 0),
    metrics,
    repos: repoResults,
    failures,
  };

  console.log(JSON.stringify(output, null, 2));

  if (failOnThreshold && failures.length > 0) {
    process.exit(1);
  }
} finally {
  if (keep) {
    console.error(`[real-repos] Work root kept at ${workRoot}`);
  } else if (!options.workDir) {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

async function runTask(repo, task, projectRoot) {
  const outputs = [];
  const structuredResults = [];

  if (task.type === 'stale_sync') {
    touchExpectedFile(projectRoot, task);
    outputs.push(await runTool(projectRoot, 'sync_project', { project: projectRoot }));
  }

  outputs.push(await runTool(projectRoot, 'resolve_project', { project: projectRoot }));
  outputs.push(await runTool(projectRoot, 'search_code', {
    project: projectRoot,
    query: task.query,
    limit: Number(limit),
    searchMode: 'hybrid',
  }));
  outputs.push(await runTool(projectRoot, 'get_context_pack', {
    project: projectRoot,
    query: task.query,
    tokenBudget: 8000,
    levels: 'L3',
  }));

  if (task.type === 'related_tests') {
    const target = task.expectedFiles[0] ?? task.expectedSymbols[0] ?? task.query;
    outputs.push(await runTool(projectRoot, 'get_related_tests', { project: projectRoot, target }));
  }

  if (task.type === 'impact_analysis' || task.type === 'new_api_parameter') {
    const target = task.expectedSymbols[0] ?? task.expectedFiles[0] ?? task.query;
    outputs.push(await runTool(projectRoot, 'impact_analysis', { project: projectRoot, target }));
  }

  if (task.type === 'follow_up_delta') {
    const sessionId = `real-repo-${repo.name}-${task.id}`;
    outputs.push(await runTool(projectRoot, 'get_context_pack', {
      project: projectRoot,
      query: task.query,
      tokenBudget: 8000,
      levels: 'L3',
      sessionId,
    }));
    outputs.push(await runTool(projectRoot, 'get_context_pack', {
      project: projectRoot,
      query: task.query,
      tokenBudget: 8000,
      levels: 'L3',
      sessionId,
      avoidRepeated: true,
    }));
  }

  for (const symbol of task.expectedSymbols) {
    outputs.push(await runTool(projectRoot, 'find_definition', {
      project: projectRoot,
      symbolName: symbol,
    }));
  }

  const combinedText = outputs.map((output) => output.stdout).join('\n');
  for (const output of outputs) {
    const structured = extractStructuredToolResult(output.stdout);
    if (structured) structuredResults.push(structured);
  }

  const foundFiles = task.expectedFiles.filter((file) => textContainsPath(combinedText, file));
  const foundSymbols = task.expectedSymbols.filter((symbol) => combinedText.includes(symbol));
  const expectedTestFiles = task.expectedFiles.filter((file) => /(^|[/.\\])(?:test|tests|__tests__|spec)([/.\\]|$)|\.(?:test|spec)\./i.test(file));
  const foundTestFiles = expectedTestFiles.filter((file) => textContainsPath(combinedText, file));

  const wrongProjectRoutes = structuredResults.filter((result) => {
    const root = result?.project?.root;
    return typeof root === 'string' && normalizePath(root) !== normalizePath(projectRoot);
  }).length;
  const staleFailures = structuredResults.filter((result) => {
    const status = result?.status;
    const indexStatus = result?.freshness?.indexStatus;
    return status === 'stale' || indexStatus === 'stale';
  }).length;

  return {
    id: task.id,
    type: task.type,
    query: task.query,
    expectedFiles: task.expectedFiles,
    expectedSymbols: task.expectedSymbols,
    foundFiles,
    foundSymbols,
    expectedTestFiles,
    foundTestFiles,
    toolCallCount: outputs.length,
    structuredResultCount: structuredResults.length,
    metrics: {
      realRepoKeyFileRecall: ratio(foundFiles.length, task.expectedFiles.length),
      realRepoEvidenceCoverage: ratio(foundSymbols.length, task.expectedSymbols.length),
      relatedTestRecall: expectedTestFiles.length > 0 ? ratio(foundTestFiles.length, expectedTestFiles.length) : null,
      wrongProjectRouteRate: ratio(wrongProjectRoutes, structuredResults.length),
      staleFailureRate: ratio(staleFailures, structuredResults.length),
    },
  };
}

async function prepareRepo(repo, projectRoot) {
  if (existsSync(join(projectRoot, '.git'))) {
    await run('git', ['fetch', '--depth', '1', 'origin', repo.commit], projectRoot);
    await run('git', ['checkout', '--force', repo.commit], projectRoot);
    return;
  }

  mkdirSync(dirname(projectRoot), { recursive: true });
  await run('git', ['clone', '--filter=blob:none', '--no-checkout', repo.repo, projectRoot], repoRoot);
  await run('git', ['checkout', '--force', repo.commit], projectRoot);
}

async function runTool(projectRoot, toolName, args) {
  return runCli([
    'tool',
    toolName,
    '--project',
    projectRoot,
    '--args',
    JSON.stringify(args),
  ], repoRoot);
}

function runCli(args, cwd) {
  return run(process.execPath, [cliPath, ...args], cwd);
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODE_MEMORY_PROJECT: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr || stdout}`));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

function loadConfig(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(stripUtf8Bom(raw));
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain an array of repo benchmark targets`);
  }
  return parsed;
}

function selectRepos(repos, repoName, taskName) {
  return repos
    .filter((repo) => repoName === 'all' || repo.name === repoName)
    .map((repo) => ({
      ...repo,
      tasks: repo.tasks.filter((task) => taskName === 'all' || task.id === taskName),
    }))
    .filter((repo) => repo.tasks.length > 0);
}

function aggregateTaskMetrics(tasks) {
  return {
    realRepoKeyFileRecall: averageMetric(tasks, 'realRepoKeyFileRecall'),
    realRepoEvidenceCoverage: averageMetric(tasks, 'realRepoEvidenceCoverage'),
    relatedTestRecall: averageMetric(tasks, 'relatedTestRecall'),
    wrongProjectRouteRate: averageMetric(tasks, 'wrongProjectRouteRate'),
    staleFailureRate: averageMetric(tasks, 'staleFailureRate'),
  };
}

function aggregateRepoMetrics(repos) {
  const tasks = repos.flatMap((repo) => repo.tasks);
  return aggregateTaskMetrics(tasks);
}

function checkThresholds(repo, failures) {
  const minimum = repo.minimumMetrics ?? {};
  for (const [metric, threshold] of Object.entries(minimum)) {
    const value = repo.metrics[metric];
    if (value === null || value === undefined) continue;
    const isRateMax = metric === 'wrongProjectRouteRate' || metric === 'staleFailureRate';
    if (isRateMax && value > threshold) {
      failures.push(`${repo.name} ${metric} ${value} exceeds ${threshold}`);
    } else if (!isRateMax && value < threshold) {
      failures.push(`${repo.name} ${metric} ${value} is below ${threshold}`);
    }
  }
}

function averageMetric(tasks, key) {
  const values = tasks
    .map((task) => task.metrics[key])
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function ratio(numerator, denominator) {
  if (denominator <= 0) return 1;
  return round(numerator / denominator);
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function textContainsPath(text, expectedPath) {
  return normalizePath(text).includes(normalizePath(expectedPath));
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function extractStructuredToolResult(text) {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && 'status' in parsed && 'project' in parsed) {
      return parsed;
    }
  } catch {
    // Tool text can include non-structured diagnostics before JSON.
  }
  return null;
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function touchExpectedFile(projectRoot, task) {
  const file = task.expectedFiles[0];
  if (!file) return;
  const filePath = join(projectRoot, file);
  if (!existsSync(filePath)) return;
  const marker = `\n/* code-memory real-repo stale-sync marker ${Date.now()} */\n`;
  writeFileSync(filePath, readFileSync(filePath, 'utf8') + marker);
}

function stripUtf8Bom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index++;
    }
  }
  return parsed;
}
