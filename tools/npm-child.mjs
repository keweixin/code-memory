import { execFileSync } from 'node:child_process';

export function npmChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_')) {
      delete env[key];
    }
  }
  return env;
}

export function runNpm(args, options = {}) {
  const env = npmChildEnv();
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      ...options,
      env,
    });
  }

  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    env,
  });
}
