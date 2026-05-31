import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'code-memory-pack-smoke-'));
let tarball = null;

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return execFileSync('npm', args, { ...options, shell: process.platform === 'win32' });
}

try {
  const packOutput = runNpm(['pack', '--json'], { cwd: root, encoding: 'utf-8' });
  const [{ filename }] = JSON.parse(packOutput);
  tarball = join(root, filename);

  runNpm(['init', '-y'], { cwd: temp, stdio: 'ignore' });
  runNpm(['install', tarball], { cwd: temp, stdio: 'inherit' });

  mkdirSync(join(temp, 'src'), { recursive: true });
  writeFileSync(join(temp, 'src', 'index.ts'), 'export function hello(): string { return "world"; }\n', 'utf-8');

  const bin = join(temp, 'node_modules', 'code-memory', 'dist', 'index.js');
  const runCodeMemory = (args) => execFileSync(process.execPath, [bin, ...args], { cwd: temp, stdio: 'inherit' });
  runCodeMemory(['--help']);
  runCodeMemory(['init', '--embedding', 'none']);
  runCodeMemory(['doctor']);
  runCodeMemory(['index', '--full', '--workers', '0']);
  runCodeMemory(['query', 'hello', '--json']);
} finally {
  rmSync(temp, { recursive: true, force: true });
  if (tarball && existsSync(tarball)) unlinkSync(tarball);
}
