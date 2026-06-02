import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const registryArg = '--registry=https://registry.npmjs.org';
const auditArgs = ['audit', registryArg];

const npmExecPath = process.env.npm_execpath;
const useCurrentNpmCli = npmExecPath && existsSync(npmExecPath);

const result = useCurrentNpmCli
  ? spawnSync(process.execPath, [npmExecPath, ...auditArgs], { stdio: 'inherit' })
  : spawnSync('npm', auditArgs, { stdio: 'inherit', shell: process.platform === 'win32' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
