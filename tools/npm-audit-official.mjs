import { runNpm } from './npm-child.mjs';

const registryArg = '--registry=https://registry.npmjs.org';
const auditArgs = ['audit', registryArg];

runNpm(auditArgs, { cwd: process.cwd(), stdio: 'inherit' });
