#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, 'dist', 'index.js');

const options = parseArgs(process.argv.slice(2));
const fileCount = Number(options.files ?? 2000);
const workers = String(options.workers ?? 'auto');
const embedding = String(options.embedding ?? 'none');
const tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-benchmark-'));

try {
  createBenchmarkProject(tempRoot, fileCount);
  await runCli(['init', '--embedding', embedding, '--languages', 'typescript', 'javascript'], tempRoot);

  const indexArgs = ['index', '--full', '--workers', workers];
  if (options['embedding-batch-size']) {
    indexArgs.push('--embedding-batch-size', String(options['embedding-batch-size']));
  }
  if (options['embedding-concurrency']) {
    indexArgs.push('--embedding-concurrency', String(options['embedding-concurrency']));
  }

  const startedAt = Date.now();
  const indexRun = await runCli(indexArgs, tempRoot, { sampleMemory: true });
  const durationMs = Date.now() - startedAt;
  const statusRun = await runCli(['status', '--json'], tempRoot);
  const status = JSON.parse(statusRun.stdout.slice(statusRun.stdout.indexOf('{')));
  if (fileCount > 0 && Number(status.files || 0) === 0) {
    throw new Error(`Benchmark indexed 0 files. Index stderr:\n${indexRun.stderr}`);
  }
  const throughput = status.files > 0 ? status.files / (durationMs / 1000) : 0;

  console.log(JSON.stringify({
    projectRoot: tempRoot,
    requestedFiles: fileCount,
    workers,
    parseWorkers: status.parseWorkers,
    embedding,
    files: status.files,
    symbols: status.symbols,
    chunks: status.chunks,
    edges: status.edges,
    durationMs,
    peakRssMb: Number((indexRun.peakRssBytes / 1024 / 1024).toFixed(1)),
    parseThroughputFilesPerSec: Number(throughput.toFixed(1)),
  }, null, 2));
} finally {
  if (options.keep) {
    console.error(`Benchmark project kept at ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

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

function runCli(args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let peakRssBytes = 0;
    const sampler = options.sampleMemory
      ? setInterval(() => {
          peakRssBytes = Math.max(peakRssBytes, sampleRssBytes(child.pid));
        }, 250)
      : null;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (sampler) clearInterval(sampler);
      reject(error);
    });
    child.on('close', (code) => {
      if (sampler) clearInterval(sampler);
      peakRssBytes = Math.max(peakRssBytes, sampleRssBytes(child.pid));
      if (code !== 0) {
        reject(new Error(`code-memory ${args.join(' ')} exited ${code}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr, peakRssBytes });
    });
  });
}

function sampleRssBytes(pid) {
  if (!pid) return 0;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
      ], { encoding: 'utf8', windowsHide: true });
      return Number(result.stdout.trim()) || 0;
    }
    const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    return (Number(result.stdout.trim()) || 0) * 1024;
  } catch {
    return 0;
  }
}
