import { runNpm } from './npm-child.mjs';

runNpm(['pack', '--dry-run'], { cwd: process.cwd(), stdio: 'inherit' });
