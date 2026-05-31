import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../src/cli/commands/init.js';

describe('CLI init command', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-init-'));
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('defaults embedding to none unless the user enables a provider', async () => {
    await initProject({});

    const config = JSON.parse(
      readFileSync(join(tempRoot, '.code-memory', 'config.json'), 'utf-8'),
    );

    expect(config.embedding.provider).toBe('none');
    expect(config.embedding.model).toBe('none');
  });

  it('uses a provider-appropriate default embedding model', async () => {
    await initProject({ embedding: 'openai' });

    const config = JSON.parse(
      readFileSync(join(tempRoot, '.code-memory', 'config.json'), 'utf-8'),
    );

    expect(config.embedding.provider).toBe('openai');
    expect(config.embedding.model).toBe('text-embedding-3-small');
  });
});
