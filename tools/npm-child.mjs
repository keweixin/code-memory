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
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')], {
      ...options,
      env,
    });
  }

  return execFileSync('npm', args, {
    ...options,
    env,
  });
}
