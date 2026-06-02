import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';
import { ContextPacker } from '../src/search/context-packer.js';
import { createMemory } from '../src/storage/memory-repository.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'context-pack-quality',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    indexing: {
      workers: 0,
      parseBatchSize: 20,
      edgeMode: 'full',
    },
    embedding: {
      provider: 'none',
      model: 'none',
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

describe('context pack quality', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-context-quality-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns real snippets and explains why they were selected', async () => {
    const config = createConfig(tempRoot);
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(join(tempRoot, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const db = getDatabaseSync();
    const results = await new HybridSearchEngine(db).searchCode('login', {
      searchMode: 'hybrid',
      limit: 5,
    });
    const pack = await new ContextPacker(db).pack('login', results, {
      tokenBudget: 8000,
      includeProjectCard: true,
      includeMemories: true,
      maxLevel: 'L4',
    });

    expect(pack.codeSnippets.length).toBeGreaterThan(0);
    expect(pack.evidence?.length).toBeGreaterThan(0);
    expect(pack.evidence?.some((item) => item.filePath === 'src/services/AuthService.ts')).toBe(true);
    expect(pack.codeSnippets.some((snippet) => snippet.content.includes('login'))).toBe(true);
    expect(pack.codeSnippets[0].reason).toMatch(/score|Matched|graph|keyword/i);
    expect(pack.files[0].language).not.toBe('unknown');
    expect(new ContextPacker(db).formatAsText(pack)).toContain('=== Evidence ===');
  }, 20_000);

  it('filters memories by query relevance and stale commit evidence', async () => {
    const config = createConfig(tempRoot);
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(join(tempRoot, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const db = getDatabaseSync();
    db.run(
      "INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('current_commit', 'new-commit')",
    );
    const now = new Date().toISOString();
    createMemory({
      id: 'memory-relevant-login',
      type: 'repo',
      content: 'Login flow uses password verification and token issuance.',
      scope: ['src/services/AuthService.ts'],
      evidence: ['src/services/AuthService.ts'],
      confidence: 0.8,
      createdCommit: 'new-commit',
      lastValidatedCommit: 'new-commit',
      invalidationRules: [],
      createdAt: now,
      updatedAt: now,
    });
    createMemory({
      id: 'memory-irrelevant-billing',
      type: 'repo',
      content: 'Billing invoices use a separate reconciliation worker.',
      scope: ['src/billing/reconcile.ts'],
      evidence: ['src/billing/reconcile.ts'],
      confidence: 1,
      createdCommit: 'new-commit',
      lastValidatedCommit: 'new-commit',
      invalidationRules: [],
      createdAt: now,
      updatedAt: now,
    });
    createMemory({
      id: 'memory-stale-login',
      type: 'repo',
      content: 'Stale login memory that should not be packed.',
      scope: ['src/services/AuthService.ts'],
      evidence: ['src/services/AuthService.ts'],
      confidence: 1,
      createdCommit: 'old-commit',
      lastValidatedCommit: 'old-commit',
      invalidationRules: [{
        type: 'commit',
        target: 'old-commit',
        description: 'Stale when commit changes',
      }],
      createdAt: now,
      updatedAt: now,
    });

    const results = await new HybridSearchEngine(db).searchCode('login', {
      searchMode: 'hybrid',
      limit: 5,
    });
    const pack = await new ContextPacker(db).pack('login', results, {
      tokenBudget: 8000,
      includeProjectCard: false,
      includeMemories: true,
      maxLevel: 'L2',
    });
    const formatted = new ContextPacker(db).formatAsText(pack);

    expect(formatted).toContain('Login flow uses password verification');
    expect(formatted).not.toContain('Billing invoices');
    expect(formatted).not.toContain('Stale login memory');
  }, 20_000);
});
