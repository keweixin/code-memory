#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--minWorkers'));

const result = spawnSync(process.execPath, [vitestBin, ...args], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
