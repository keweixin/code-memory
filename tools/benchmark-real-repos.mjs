#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, 'dist', 'index.js');

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(formatHelp());
  process.exit(0);
}

const configPath = resolve(repoRoot, String(options.config ?? 'benchmark/real-repos.json'));
const repoFilter = String(options.repo ?? 'all');
const taskFilter = String(options.task ?? 'all');
const embedding = String(options.embedding ?? 'none');
const workers = String(options.workers ?? 'auto');
const limit = String(options.limit ?? '20');
const commandTimeoutMinutes = Number(options.commandTimeoutMinutes ?? options.timeoutMinutes ?? 45);
const dryRun = Boolean(options.dryRun);
const keep = Boolean(options.keep);
const failOnThreshold = Boolean(options.failOnThreshold);
const globalThresholds = {
  allowedNextReadsRecall: numberEnv('CODE_MEMORY_REAL_REPO_MIN_ALLOWED_NEXT_READS_RECALL', 0.9),
  exactSnippetCoverage: numberEnv('CODE_MEMORY_REAL_REPO_MIN_EXACT_SNIPPET_COVERAGE', 0.8),
  fileLineEvidenceCoverage: numberEnv('CODE_MEMORY_REAL_REPO_MIN_FILE_LINE_EVIDENCE_COVERAGE', 0.95),
  structuredResultCoverage: numberEnv('CODE_MEMORY_REAL_REPO_MIN_STRUCTURED_RESULT_COVERAGE', 1),
  wrongProjectRouteRate: numberEnv('CODE_MEMORY_REAL_REPO_MAX_WRONG_PROJECT_ROUTE_RATE', 0),
  staleFailureRate: numberEnv('CODE_MEMORY_REAL_REPO_MAX_STALE_FAILURE_RATE', 0),
};
const outputDir = resolve(repoRoot, String(options.outputDir ?? 'benchmark-results'));
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
      sparsePaths: repo.sparsePaths ?? [],
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
  if (failOnThreshold) checkGlobalThresholds(metrics, failures);
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
  writeBenchmarkArtifacts(output, outputDir);

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

function writeBenchmarkArtifacts(output, dir) {
  mkdirSync(dir, { recursive: true });
  const artifact = sanitizeBenchmarkArtifact(output);
  writeFileSync(join(dir, 'real-repos.latest.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'real-repos.summary.md'), formatBenchmarkSummary(artifact), 'utf8');
}

function sanitizeBenchmarkArtifact(output) {
  return {
    ...output,
    configPath: 'benchmark/real-repos.json',
    workRoot: '<benchmark-workdir>',
    repos: output.repos.map((repo) => ({
      ...repo,
      projectRoot: `<benchmark-workdir>/${repo.name}`,
    })),
  };
}

function formatBenchmarkSummary(output) {
  const lines = [
    '# Real Repo Benchmark Summary',
    '',
    `Generated: ${output.completedAt}`,
    `Status: ${output.status}`,
    `Repos: ${output.repoCount}`,
    `Tasks: ${output.taskCount}`,
    '',
    '| Metric | Result |',
    '|---|---:|',
  ];
  for (const [name, value] of Object.entries(output.metrics)) {
    lines.push(`| ${name} | ${value === null || value === undefined ? 'n/a' : value} |`);
  }
  lines.push('', '| Repo | Tasks | Key file recall | Evidence coverage | Related test recall | Wrong route rate | Stale failure rate |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const repo of output.repos) {
    lines.push([
      `| ${repo.name}`,
      repo.taskCount,
      repo.metrics.realRepoKeyFileRecall ?? 'n/a',
      repo.metrics.realRepoEvidenceCoverage ?? 'n/a',
      repo.metrics.relatedTestRecall ?? 'n/a',
      repo.metrics.wrongProjectRouteRate ?? 'n/a',
      `${repo.metrics.staleFailureRate ?? 'n/a'} |`,
    ].join(' | '));
  }
  if (output.failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const failure of output.failures) lines.push('- ' + failure);
  }
  lines.push('');
  return lines.join('\n');
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
    const target = task.target ?? task.expectedSymbols[0] ?? task.expectedFiles[0] ?? task.query;
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
    if (structured) structuredResults.push({ toolName: output.toolName, result: structured });
  }

  const structuredFacts = collectStructuredFacts(structuredResults.map((item) => item.result));
  const foundFiles = task.expectedFiles.filter((file) => containsNormalizedPath(structuredFacts.paths, file));
  const foundSymbols = task.expectedSymbols.filter((symbol) => containsStringValue(structuredFacts.symbols, symbol));
  const expectedTestFiles = task.expectedFiles.filter((file) => /(^|[/.\\])(?:test|tests|__tests__|spec)([/.\\]|$)|\.(?:test|spec)\./i.test(file));
  const foundTestFiles = expectedTestFiles.filter((file) => containsNormalizedPath(structuredFacts.testPaths, file));
  const textOnlyHitRate = calculateTextOnlyHitRate({
    combinedText,
    expectedFiles: task.expectedFiles,
    expectedSymbols: task.expectedSymbols,
    expectedTestFiles,
    structuredFacts,
  });

  const wrongProjectRoutes = structuredResults.filter(({ result }) => {
    const root = result?.project?.root;
    return typeof root === 'string' && normalizePath(root) !== normalizePath(projectRoot);
  }).length;
  const staleCheckedResults = structuredResults.filter(({ toolName }) => !isProjectManagementTool(toolName));
  const staleFailures = staleCheckedResults.filter(({ result }) => {
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
      staleFailureRate: ratio(staleFailures, staleCheckedResults.length),
      structuredResultCoverage: ratio(structuredResults.length, outputs.length),
      textOnlyHitRate,
      allowedNextReadsRecall: ratio(
        task.expectedFiles.filter((file) => containsNormalizedPath(structuredFacts.allowedReadPaths, file)).length,
        task.expectedFiles.length,
      ),
      exactSnippetCoverage: ratio(
        task.expectedFiles.filter((file) => containsNormalizedPath(structuredFacts.exactSnippetPaths, file)).length,
        task.expectedFiles.length,
      ),
      fileLineEvidenceCoverage: ratio(
        task.expectedFiles.filter((file) => containsNormalizedPath(structuredFacts.evidencePaths, file)).length,
        task.expectedFiles.length,
      ),
    },
  };
}

async function prepareRepo(repo, projectRoot) {
  if (existsSync(join(projectRoot, '.git'))) {
    await configureSparseCheckout(repo, projectRoot);
    await run('git', ['fetch', '--depth', '1', '--filter=blob:none', 'origin', repo.commit], projectRoot);
    await run('git', ['checkout', '--force', 'FETCH_HEAD'], projectRoot);
    return;
  }

  mkdirSync(dirname(projectRoot), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  await run('git', ['init'], projectRoot);
  await run('git', ['remote', 'add', 'origin', repo.repo], projectRoot);
  await configureSparseCheckout(repo, projectRoot);
  await run('git', ['fetch', '--depth', '1', '--filter=blob:none', 'origin', repo.commit], projectRoot);
  await run('git', ['checkout', '--force', 'FETCH_HEAD'], projectRoot);
}

async function configureSparseCheckout(repo, projectRoot) {
  const sparsePaths = Array.isArray(repo.sparsePaths)
    ? repo.sparsePaths.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (sparsePaths.length === 0) return;

  await run('git', ['sparse-checkout', 'init', '--no-cone'], projectRoot);
  await run('git', ['sparse-checkout', 'set', '--no-cone', ...sparsePaths], projectRoot);
}

async function runTool(projectRoot, toolName, args) {
  const output = await runCli([
    'tool',
    toolName,
    '--project',
    projectRoot,
    '--args',
    JSON.stringify(args),
  ], repoRoot);
  return { ...output, toolName };
}

function runCli(args, cwd) {
  return run(process.execPath, [cliPath, ...args], cwd);
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const started = Date.now();
    const printable = `${command} ${args.join(' ')}`;
    console.error(`[real-repos] ${new Date().toISOString()} start: ${printable}`);
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
    let settled = false;
    const timeoutMs = Math.max(1, commandTimeoutMinutes) * 60 * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${printable} timed out after ${commandTimeoutMinutes} minutes\n${stderr || stdout}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationSeconds = Math.round((Date.now() - started) / 100) / 10;
      if (code !== 0) {
        reject(new Error(`${printable} exited ${code} after ${durationSeconds}s\n${stderr || stdout}`));
        return;
      }
      console.error(`[real-repos] ${new Date().toISOString()} done: ${printable} (${durationSeconds}s)`);
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
    structuredResultCoverage: averageMetric(tasks, 'structuredResultCoverage'),
    textOnlyHitRate: averageMetric(tasks, 'textOnlyHitRate'),
    allowedNextReadsRecall: averageMetric(tasks, 'allowedNextReadsRecall'),
    exactSnippetCoverage: averageMetric(tasks, 'exactSnippetCoverage'),
    fileLineEvidenceCoverage: averageMetric(tasks, 'fileLineEvidenceCoverage'),
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

function checkGlobalThresholds(metrics, failures) {
  checkMin(metrics.allowedNextReadsRecall, globalThresholds.allowedNextReadsRecall, 'global allowedNextReadsRecall', failures);
  checkMin(metrics.exactSnippetCoverage, globalThresholds.exactSnippetCoverage, 'global exactSnippetCoverage', failures);
  checkMin(metrics.fileLineEvidenceCoverage, globalThresholds.fileLineEvidenceCoverage, 'global fileLineEvidenceCoverage', failures);
  checkMin(metrics.structuredResultCoverage, globalThresholds.structuredResultCoverage, 'global structuredResultCoverage', failures);
  checkMax(metrics.wrongProjectRouteRate, globalThresholds.wrongProjectRouteRate, 'global wrongProjectRouteRate', failures);
  checkMax(metrics.staleFailureRate, globalThresholds.staleFailureRate, 'global staleFailureRate', failures);
}

function checkMin(value, threshold, label, failures) {
  if (value === null || value === undefined) {
    failures.push(`${label} is missing`);
  } else if (value < threshold) {
    failures.push(`${label} ${value} is below ${threshold}`);
  }
}

function checkMax(value, threshold, label, failures) {
  if (value === null || value === undefined) {
    failures.push(`${label} is missing`);
  } else if (value > threshold) {
    failures.push(`${label} ${value} exceeds ${threshold}`);
  }
}

function isProjectManagementTool(toolName) {
  return toolName === 'resolve_project' ||
    toolName === 'bootstrap_project' ||
    toolName === 'sync_project' ||
    toolName === 'register_project';
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

function containsNormalizedPath(paths, expectedPath) {
  const normalizedExpected = normalizePath(expectedPath);
  return paths.some((pathValue) => normalizePath(pathValue).includes(normalizedExpected));
}

function containsStringValue(values, expectedValue) {
  const expected = String(expectedValue).toLowerCase();
  return values.some((value) => String(value).toLowerCase().includes(expected));
}

function collectStructuredFacts(results) {
  const facts = {
    paths: [],
    symbols: [],
    evidencePaths: [],
    allowedReadPaths: [],
    exactSnippetPaths: [],
    testPaths: [],
  };

  for (const result of results) {
    collectFactsFromValue(result, [], facts);
  }

  facts.paths = uniqueValues(facts.paths);
  facts.symbols = uniqueValues(facts.symbols);
  facts.evidencePaths = uniqueValues(facts.evidencePaths);
  facts.allowedReadPaths = uniqueValues(facts.allowedReadPaths);
  facts.exactSnippetPaths = uniqueValues(facts.exactSnippetPaths);
  facts.testPaths = uniqueValues(facts.testPaths);
  return facts;
}

function collectFactsFromValue(value, path, facts) {
  if (value === null || value === undefined) return;
  if (isInputEchoPath(path)) return;
  if (typeof value === 'string') {
    if (looksLikePathValue(value)) addPathFact(value, path, facts);
    if (looksLikeSymbolValue(value)) facts.symbols.push(value);
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFactsFromValue(item, [...path, String(index)], facts));
    return;
  }

  const entries = Object.entries(value);
  const objectPathValue = getObjectPathValue(value);
  if (objectPathValue) {
    addPathFact(objectPathValue, path, facts);
    if (hasLineEvidence(value)) facts.evidencePaths.push(objectPathValue);
    if (hasExactSnippetEvidence(value)) facts.exactSnippetPaths.push(objectPathValue);
    if (isAllowedReadPath(path)) facts.allowedReadPaths.push(objectPathValue);
  }

  const nameValue = typeof value.name === 'string' ? value.name : typeof value.symbolName === 'string' ? value.symbolName : null;
  if (nameValue) facts.symbols.push(nameValue);

  for (const [key, child] of entries) {
    if (key === 'display') continue;
    collectFactsFromValue(child, [...path, key], facts);
  }
}

function addPathFact(value, path, facts) {
  facts.paths.push(value);
  if (isTestPath(value)) facts.testPaths.push(value);
  if (isAllowedReadPath(path)) facts.allowedReadPaths.push(value);
  if (isExactSnippetPath(path)) facts.exactSnippetPaths.push(value);
  if (isEvidencePath(path)) facts.evidencePaths.push(value);
}

function getObjectPathValue(value) {
  for (const key of ['path', 'file', 'filePath', 'relativePath']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return null;
}

function hasLineEvidence(value) {
  return typeof value.line === 'number' ||
    typeof value.startLine === 'number' ||
    typeof value.endLine === 'number' ||
    typeof value.lines === 'string' ||
    Array.isArray(value.lineRange);
}

function hasExactSnippetEvidence(value) {
  return typeof value.code === 'string' &&
    (hasLineEvidence(value) || typeof value.whyIncluded === 'string' || typeof value.why === 'string');
}

function isAllowedReadPath(path) {
  return path.some((part) => part === 'allowedNextReads' || part === 'nextAllowedReads');
}

function isExactSnippetPath(path) {
  return path.some((part) => part === 'exactSnippets');
}

function isEvidencePath(path) {
  return path.some((part) => part === 'evidence' || part === 'whyIncluded' || part === 'exactSnippets');
}

function isInputEchoPath(path) {
  const key = path[path.length - 1];
  return key === 'query' || key === 'target' || key === 'command' || key === 'runCommand';
}

function looksLikePathValue(value) {
  return /[\\/]/.test(value) && /\.[a-z0-9]+$/i.test(value.split(/[#?]/)[0]);
}

function looksLikeSymbolValue(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$.:#-]{1,120}$/.test(value);
}

function isTestPath(value) {
  return /(^|[/.\\])(?:test|tests|__tests__|spec)([/.\\]|$)|\.(?:test|spec)\./i.test(value);
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function calculateTextOnlyHitRate({ combinedText, expectedFiles, expectedSymbols, expectedTestFiles, structuredFacts }) {
  const expectedItems = [
    ...expectedFiles.map((value) => ({ type: 'file', value })),
    ...expectedSymbols.map((value) => ({ type: 'symbol', value })),
    ...expectedTestFiles.map((value) => ({ type: 'test', value })),
  ];
  if (expectedItems.length === 0) return 0;
  const textOnlyHits = expectedItems.filter((item) => {
    if (item.type === 'symbol') {
      return combinedText.includes(item.value) && !containsStringValue(structuredFacts.symbols, item.value);
    }
    const structuredPaths = item.type === 'test' ? structuredFacts.testPaths : structuredFacts.paths;
    return textContainsPath(combinedText, item.value) && !containsNormalizedPath(structuredPaths, item.value);
  });
  return ratio(textOnlyHits.length, expectedItems.length);
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

function formatHelp() {
  return [
    'Usage: npm run benchmark:real-repos -- [options]',
    '',
    'Options:',
    '  --dry-run                         Validate config and print selected repos without cloning.',
    '  --fail-on-threshold               Exit non-zero when global thresholds fail.',
    '  --repo <name|all>                 Run one configured repo (default: all).',
    '  --task <id|all>                   Run one configured task (default: all).',
    '  --embedding <provider>            Embedding provider for bootstrap (default: none).',
    '  --workers <count|auto>            Index workers for bootstrap (default: auto).',
    '  --work-dir <path>                 Reuse a working directory instead of a temp dir.',
    '  --output-dir <path>               Artifact output directory (default: benchmark-results).',
    '  --keep                            Keep the temporary work directory.',
    '  --timeout-minutes <minutes>       Per-command timeout (default: 45).',
    '  --help                            Show this help without running the benchmark.',
  ].join('\n');
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
