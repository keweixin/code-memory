#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const workDir = mkdtempSync(join(tmpdir(), 'code-memory-release-gate-'));
const indexOutput = join(workDir, 'benchmark-index.json');
const contextOutput = join(workDir, 'benchmark-context.json');
const agentOutput = join(workDir, 'benchmark-agent.json');

const steps = [
  npmRun('lint'),
  npmRun('build'),
  npmRun('test', ['--', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism']),
  npmRun('test:coverage', ['--', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism']),
  npmRun('pack:check'),
  npmRun('test:smoke'),
  npmRun('audit:official'),
  npmRun('benchmark:index', ['--', '--files', '2000', '--workers', 'auto', '--embedding', 'none'], indexOutput),
  npmRun('benchmark:context', [], contextOutput),
  npmRun('benchmark:agent', [], agentOutput),
  npmRun('benchmark:gate', ['--', '--index', indexOutput, '--context', contextOutput, '--agent', agentOutput]),
  npmRun('benchmark:real-repos', ['--', '--dry-run']),
];

try {
  for (const step of steps) {
    await runStep(step);
  }
  console.log('[release-gate] all checks passed');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function npmRun(script, args = [], outputFile = null) {
  const npmArgs = ['run', script, ...args];
  return {
    command: npmCommand,
    args: process.platform === 'win32'
      ? ['/d', '/s', '/c', ['npm', ...npmArgs].map(quoteCmdArg).join(' ')]
      : npmArgs,
    label: `npm run ${script}${args.length ? ' ' + args.join(' ') : ''}`,
    outputFile,
  };
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[ \t"&^<>|]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function runStep(step) {
  return new Promise((resolve, reject) => {
    console.error(`[release-gate] start: ${step.label}`);
    const child = spawn(step.command, step.args, {
      cwd: process.cwd(),
      shell: false,
      stdio: step.outputFile ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });

    let stdout = '';
    if (step.outputFile && child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (step.outputFile) {
        writeFileSync(step.outputFile, stdout, 'utf8');
      } else {
        stdout = '';
      }
      finish(code, resolve, reject, step);
    });
  });
}

function finish(code, resolve, reject, step) {
  if (code === 0) {
    console.error(`[release-gate] passed: ${step.label}`);
    resolve();
    return;
  }
  reject(new Error(`[release-gate] failed: ${step.label} exited with ${code}`));
}
