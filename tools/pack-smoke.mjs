import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runNpm } from './npm-child.mjs';

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'code-memory-pack-smoke-'));
let tarball = null;

try {
  const packOutput = runNpm(['pack', '--json'], { cwd: root, encoding: 'utf-8' });
  const [{ filename }] = JSON.parse(packOutput);
  tarball = join(root, filename);

  runNpm(['init', '-y'], { cwd: temp, stdio: 'ignore' });
  runNpm(['install', tarball], { cwd: temp, stdio: 'inherit' });

  mkdirSync(join(temp, 'src'), { recursive: true });
  writeFileSync(join(temp, 'src', 'index.ts'), 'export function hello(): string { return "world"; }\n', 'utf-8');

  runNpm([
    'exec',
    '--yes',
    '--package',
    tarball,
    '--',
    'code-memory',
    'setup',
    '--agent',
    'cursor',
    '--project',
    temp,
    '--no-bootstrap',
    '--no-hooks',
  ], { cwd: temp, stdio: 'inherit' });

  const cursorConfig = JSON.parse(readFileSync(join(temp, '.cursor', 'mcp.json'), 'utf-8'));
  const server = cursorConfig.mcpServers?.['code-memory'];
  if (
    server?.command !== 'npx' ||
    !server.args?.includes('code-memory@latest') ||
    !server.args?.includes('--auto-project') ||
    server.args?.includes('--project')
  ) {
    throw new Error('Packed setup smoke failed to write the default npx global MCP config.');
  }
  if (!readFileSync(join(temp, 'AGENTS.md'), 'utf-8').includes('CODE_MEMORY_CONTEXT_START')) {
    throw new Error('Packed setup smoke failed to write AGENTS.md Code Memory context.');
  }

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
