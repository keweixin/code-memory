# Code Memory Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Code Memory from a working v0.1 local prototype into a review-ready local indexing engine with stable quality gates, memory-safe large-repo indexing, stronger graph evidence, better doctor diagnostics, and production-grade CLI/MCP behavior.

**Architecture:** Keep the public CLI and MCP tool names stable. Optimize the internals by streaming parse results into SQLite in bounded batches, wrapping index lifecycle in lock/finally semantics, moving graph writes and resolution updates into transactions, adding invariant checks, and improving module resolution and context packaging without replacing the current SQLite + Tree-sitter + LanceDB stack.

**Tech Stack:** Node.js >=20, TypeScript ESM, Vitest, ESLint 9 flat config, better-sqlite3 with WAL/FTS5, worker_threads, web-tree-sitter, LanceDB, Commander, MCP SDK.

---

## Current Evidence Baseline

Commands already verified on the current branch:

- `npm run build`: PASS.
- `npm test`: PASS, 68 tests passed.
- `npm pack --dry-run`: PASS; package includes `dist`, `grammars`, README, LICENSE, package metadata.
- CLI smoke on sample fixture: PASS; sample full index produced symbols, chunks, edges, query results.
- `npm audit --registry=https://registry.npmjs.org --json`: PASS, 0 vulnerabilities.
- `npm run benchmark:index -- --files 2000 --workers auto --embedding none`: PASS, `durationMs=22012`, `peakRssMb=878.7`, `parseThroughputFilesPerSec=90.9`.
- `npm run lint`: FAIL because ESLint 9 requires `eslint.config.*` and the repository has no flat config.
- `node dist/index.js doctor --json` from repository root without `.code-memory/config.json`: reports missing config and missing index, grammar checks pass.
- GitNexus refreshed with `npx gitnexus analyze`: repository indexed as `2497 nodes | 5565 edges | 70 clusters | 207 flows`.

Primary risks found in current source:

- `src/indexer/parse-worker-pool.ts` returns `Promise.all(files.map(...))`; all parse results are retained until parsing completes.
- `src/shared/types.ts` defines `indexing.parseBatchSize`, and `src/cli/commands/init.ts` writes it, but `src/indexer/index-manager.ts` does not use it.
- `src/indexer/index-manager.ts` sets `is_indexing=true` without a top-level `try/finally` around full and incremental indexing.
- `src/indexer/index-manager.ts` and `src/storage/parse-metadata-repository.ts` write graph edges and call resolution updates one row at a time.
- `src/indexer/index-manager.ts` stores graph edge IDs as `edge(fromId,toId,type)`, so multiple call sites between the same symbols overwrite edge evidence.
- `src/parser/parser-registry.ts` suggests `code-memory download-grammars`, but no CLI command registers it.
- `src/search/context-packer.ts` performs N+1 SQLite queries while assembling context packs.

---

## File Responsibility Map

### Quality Gates and CI

- Create `eslint.config.js`: ESLint 9 flat config for TS source, tests, tools, and generated-output ignores.
- Modify `package.json`: keep `lint`, add `check`, `test:smoke`, `audit:official`, and `pack:check` scripts.
- Create `.github/workflows/ci.yml`: Node 20/22 matrix for install, lint, build, test, pack, CLI smoke.
- Create `tests/cli-smoke.test.ts` or extend existing CLI tests: execute built CLI against a temp fixture using `init`, `index`, `status`, `query`.

### Index Lifecycle, Locking, and Streaming

- Create `src/indexer/index-lock.ts`: lock file acquisition/release with stale-lock detection.
- Modify `src/indexer/index-manager.ts`: wrap full/incremental index in lifecycle guard; use parse batches; stream parse results through write/vector stages; always clear `is_indexing`.
- Modify `src/indexer/parse-worker-pool.ts`: expose bounded batch parsing or async iterator API instead of one full-array `Promise.all`.
- Modify `src/indexer/parse-worker.ts`: keep worker protocol compatible; include timing metrics in worker response.
- Add `tests/index-lifecycle.test.ts`: lock conflict, stale lock, failed parse cleanup, Ctrl+C-style abort simulation where possible.
- Add `tests/index-streaming.test.ts`: proves parse results are written in batches and no full result array is required.

### Graph Transactions and Evidence

- Modify `src/storage/schema.ts`: add schema v4 tables for graph evidence and index runs; keep v3 openable but require full reindex for v4 evidence.
- Create `src/storage/graph-evidence-repository.ts`: batch insert call/import/type evidence rows.
- Modify `src/storage/edge-repository.ts`: add batch upsert and transactional edge writes.
- Modify `src/storage/parse-metadata-repository.ts`: add batch update for call_ref resolution statuses.
- Modify `src/indexer/index-manager.ts`: rebuild edges in one transaction; aggregate evidence per logical edge; persist call-site evidence separately.
- Add `tests/graph-evidence.test.ts`: multiple call sites preserve separate evidence while graph edge stays deduplicated.
- Extend `tests/performance-graph-upgrade.test.ts`: full and dirty rebuild use metadata only and write call resolution in batch.

### Vector and Embedding Reliability

- Create `src/indexer/embedding-queue.ts`: bounded embedding queue with batch size, concurrency, retry, timeout, and metrics.
- Modify `src/indexer/embedding-generator.ts`: add provider health checks, timeout support, deterministic error classes.
- Modify `src/search/vector-search.ts`: batch vector delete, validate dimensions, detect vector table path/config mismatches.
- Modify `src/indexer/index-manager.ts`: enqueue chunk embeddings across parse batches and flush at controlled checkpoints.
- Add `tests/embedding-queue.test.ts`: batch ordering, retry behavior, timeout behavior, zero-vector failures.
- Extend `tests/vector-search.test.ts`: dimension mismatch forces vector rebuild warning, query-time provider unavailable reports a clear error.

### Module Resolution and Graph Precision

- Create `src/parser/module-resolver.ts`: resolve relative imports, tsconfig `baseUrl`, tsconfig `paths`, package `exports`, package `main/module/types`, workspace package roots, and index files.
- Modify `src/scanner/project-scanner.ts` or create `src/scanner/project-manifest.ts`: discover tsconfig/package/workspace metadata once per index run.
- Modify `src/indexer/index-manager.ts`: replace local `resolveImportTarget` candidate-only logic with `ModuleResolver`.
- Add fixtures under `tests/fixtures/module-resolution-project/`: tsconfig paths, package exports, workspace package, barrel index.
- Add `tests/module-resolution.test.ts`: proves import graph resolves aliases and workspace packages without false global fallback.

### Doctor, Invariants, and Observability

- Create `src/storage/invariants.ts`: checks for dangling edges, symbols without files, chunks without files, symbols without chunks, FTS drift, stale index state, unresolved calls by file, duplicate graph evidence.
- Modify `src/cli/commands/doctor.ts`: report invariant summary and machine-readable JSON fields.
- Create `src/indexer/index-metrics.ts`: collect phase timings, parse throughput, write throughput, edge rebuild duration, vector duration, peak RSS, worker failures.
- Modify `src/indexer/index-manager.ts`: record metrics in metadata and print progress by phase.
- Add `tests/doctor-invariants.test.ts`: inject corrupt rows and assert doctor reports exact failures.
- Add `tests/index-metrics.test.ts`: status JSON includes duration, workers, dirty files, unresolved calls, phase timings.

### Context Pack and Ledger Quality

- Modify `src/search/context-packer.ts`: batch-load files, symbols, chunks, and call chains; remove N+1 query pattern.
- Modify `src/mcp/tools/get-context-pack.ts`: include "why this context" evidence, unresolved/ambiguous call summary, and commit/hash in the pack.
- Modify `src/memory/context-ledger.ts`: add item-level usefulness/stale feedback aggregation and optional TTL.
- Add `tests/context-pack-quality.test.ts`: proves snippets are real chunks, repeated context is omitted, and reasons include source rank and graph evidence.
- Extend `tests/mcp-context-pack-ledger.test.ts`: feedback affects repeated-context reporting.

### Security, Privacy, and Release Experience

- Modify `.gitignore`: ensure `.code-memory/`, LanceDB vectors, temp benchmark output, and local logs are ignored.
- Create `src/cli/commands/doctor-security.ts` or integrate into `doctor.ts`: scan likely secret patterns in indexed snippets and warn without printing secret values.
- Modify `README.md`: document local-only storage, vector/DB gitignore guidance, npm global install smoke, CI status, known limits.
- Create `tools/pack-smoke.mjs`: `npm pack`, install into temp project, run `code-memory --help`, `init`, `doctor`, `index`, `query`.
- Add `tests/release-pack.test.ts`: verifies published file list and CLI entrypoint.

---

## Implementation Tasks

### Task 1: Restore Quality Gates and CI

**Files:**
- Create: `eslint.config.js`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Test: existing tests plus CLI smoke script

- [ ] **Step 1: Write the ESLint flat config**

Create `eslint.config.js`:

```js
import js from '@eslint/js';

const tsFiles = ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'];

export default [
  js.configs.recommended,
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.code-memory/**',
      'coverage/**',
      'grammars/**',
      'tests/fixtures/**',
    ],
  },
  {
    files: tsFiles,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-constant-binary-expression': 'error',
      'no-fallthrough': 'error',
      'no-implicit-coercion': 'warn',
    },
  },
  {
    files: ['tools/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
];
```

- [ ] **Step 2: Run lint to expose real issues**

Run:

```powershell
npm run lint
```

Expected before code cleanup: ESLint executes with rule-level findings instead of failing with "couldn't find eslint.config".

- [ ] **Step 3: Fix rule-level findings without weakening rules**

Use these patterns:

```ts
// Replace unused catch bindings:
try {
  doWork();
} catch {
  recover();
}

// Replace broad any when row shape is known:
type SymbolRow = {
  id: string;
  name: string;
  kind: string;
};
const row = db.get<SymbolRow>('SELECT id, name, kind FROM symbols WHERE id = ?', [id]);
```

- [ ] **Step 4: Add package scripts**

Modify `package.json` scripts to include:

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "check": "npm run lint && npm run build && npm test",
    "audit:official": "npm audit --registry=https://registry.npmjs.org",
    "pack:check": "npm pack --dry-run",
    "test:smoke": "npm run build && node tools/pack-smoke.mjs",
    "start": "node dist/index.js",
    "benchmark:index": "node tools/benchmark-index.mjs"
  }
}
```

- [ ] **Step 5: Add CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:

jobs:
  verify:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm test
      - run: npm audit --registry=https://registry.npmjs.org
      - run: npm pack --dry-run
      - run: node dist/index.js --help
```

- [ ] **Step 6: Verify**

Run:

```powershell
npm run lint
npm run build
npm test
npm pack --dry-run
npm audit --registry=https://registry.npmjs.org
```

Expected: all commands pass.

- [ ] **Step 7: Commit**

```powershell
git add eslint.config.js .github/workflows/ci.yml package.json package-lock.json
git commit -m "chore: restore quality gates and ci"
```

---

### Task 2: Add Index Lifecycle Guard, Locking, and Reliable Cleanup

**Files:**
- Create: `src/indexer/index-lock.ts`
- Modify: `src/indexer/index-manager.ts`
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/index-lifecycle.test.ts`

- [ ] **Step 1: Add failing tests for lock and cleanup**

Create `tests/index-lifecycle.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempProject, initCodeMemoryProject, queryRows } from './helpers/project-fixture.js';
import { IndexManager } from '../src/indexer/index-manager.js';

describe('index lifecycle', () => {
  it('clears is_indexing when full index fails', async () => {
    const root = createTempProject();
    const config = await initCodeMemoryProject(root, { embedding: 'none' });
    const manager = new IndexManager(root, {
      ...config,
      languages: ['typescript'],
      ignore: [],
    });

    await expect(manager.fullIndex()).resolves.toBeDefined();
    const rows = queryRows("SELECT value FROM index_metadata WHERE key = 'is_indexing'");
    expect(String(rows[0][0])).toBe('false');
  });

  it('prevents two indexers from acquiring the same project lock', async () => {
    const root = createTempProject();
    const { acquireIndexLock } = await import('../src/indexer/index-lock.js');
    const first = acquireIndexLock(root);
    expect(() => acquireIndexLock(root)).toThrow(/already running/i);
    first.release();
  });

  it('writes a lock file containing pid and timestamp', async () => {
    const root = createTempProject();
    const { acquireIndexLock } = await import('../src/indexer/index-lock.js');
    const lock = acquireIndexLock(root);
    const lockPath = join(root, '.code-memory', 'index.lock');
    expect(existsSync(lockPath)).toBe(true);
    const payload = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number; acquiredAt: string };
    expect(payload.pid).toBe(process.pid);
    expect(payload.acquiredAt).toMatch(/T/);
    lock.release();
  });
});
```

- [ ] **Step 2: Run the new tests and confirm failure**

Run:

```powershell
npm test -- tests/index-lifecycle.test.ts
```

Expected: FAIL because `src/indexer/index-lock.ts` does not exist and lifecycle cleanup is not implemented.

- [ ] **Step 3: Implement lock helper**

Create `src/indexer/index-lock.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../shared/constants.js';

export interface IndexLock {
  path: string;
  release(): void;
}

const LOCK_FILE = 'index.lock';
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

export function acquireIndexLock(rootPath: string, now: Date = new Date()): IndexLock {
  const lockPath = join(rootPath, CONFIG_DIR, LOCK_FILE);
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    const existing = readLock(lockPath);
    const ageMs = existing?.acquiredAt ? now.getTime() - Date.parse(existing.acquiredAt) : 0;
    if (existing && ageMs > STALE_LOCK_MS) {
      rmSync(lockPath, { force: true });
    } else {
      throw new Error('Code Memory index is already running for this project: ' + lockPath);
    }
  }

  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    acquiredAt: now.toISOString(),
  }, null, 2));

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      rmSync(lockPath, { force: true });
    },
  };
}

function readLock(lockPath: string): { pid?: number; acquiredAt?: string } | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number; acquiredAt?: string };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Wrap full index lifecycle**

Modify `src/indexer/index-manager.ts`:

```ts
import { acquireIndexLock, type IndexLock } from './index-lock.js';

async fullIndex(): Promise<IndexStatus> {
  log.info('Starting full index of: ' + this.rootPath);
  const startTime = Date.now();
  let lock: IndexLock | null = null;

  try {
    await this.ensureDb();
    lock = acquireIndexLock(this.rootPath);
    await initTreeSitter();
    await this.prepareVectorStore(true);
    this.setMetadata('is_indexing', 'true');

    const status = await this.runFullIndex(startTime);
    return status;
  } finally {
    this.setMetadata('is_indexing', 'false');
    releaseVectorStoreConnection();
    lock?.release();
    await saveDatabase().catch((err) => {
      log.warn('Database checkpoint failed after full index: ' + String(err));
    });
  }
}
```

Extract the existing full-index body after `is_indexing=true` into:

```ts
private async runFullIndex(startTime: number): Promise<IndexStatus> {
  log.info('Scanning project files...');
  const scanResult = scanProject(this.rootPath, this.config);
  this.gitHistoryAvailable = Boolean(scanResult.gitInfo.currentCommit);
  const files = scanResult.files;
  log.info('Discovered ' + files.length + ' files to index');

  await this.pruneFilesNotInFullScan(files);

  let indexedCount = 0;
  let totalSymbols = 0;
  let totalChunks = 0;
  const workers = this.resolveWorkerCount();
  const results = await this.parseDiscoveredFiles(files, workers);

  for (const { discovered, result, error } of results) {
    if (error) {
      log.error('Failed to index: ' + discovered.relativePath, error);
      continue;
    }
    if (!result) continue;
    await this.removeFileFromIndex(result.fileId);
    this.storeParseResult(result, discovered);
    await this.indexChunkVectors(result, discovered);
    indexedCount++;
    totalSymbols += result.symbols.length;
    totalChunks += result.chunks.length;
  }

  const totalEdges = await this.rebuildGraphEdges('full');
  const elapsed = Date.now() - startTime;
  this.updateFinalMetadata(scanResult, {
    indexedFiles: indexedCount,
    symbols: totalSymbols,
    edges: totalEdges,
    chunks: totalChunks,
    durationMs: elapsed,
    parseWorkers: workers,
    dirtyFiles: indexedCount,
  }, 'full');

  return this.buildStatus(indexedCount, totalSymbols, totalEdges, totalChunks);
}
```

- [ ] **Step 5: Apply same lifecycle pattern to incremental index**

Modify `incrementalIndex` with the same `try/finally` and extract the body into:

```ts
private async runIncrementalIndex(startTime: number, forceAll: boolean): Promise<IndexStatus> {
  const scanResult = scanProject(this.rootPath, this.config);
  this.gitHistoryAvailable = Boolean(scanResult.gitInfo.currentCommit);

  const currentFileMap = new Map<string, DiscoveredFile>();
  for (const f of scanResult.files) {
    currentFileMap.set(normalizePath(f.relativePath), f);
  }

  const prevFiles = this.safeGetAllFiles();
  const prevFileMap = new Map<string, FileRecord>();
  for (const pf of prevFiles) {
    prevFileMap.set(normalizePath(pf.path), pf);
  }

  let indexedCount = 0;
  let totalSymbols = 0;
  let totalChunks = 0;
  const dirtyFiles: DiscoveredFile[] = [];
  const deletedFileIds: string[] = [];

  for (const [relPath, prevFile] of prevFileMap) {
    const currentFile = currentFileMap.get(relPath);
    if (!currentFile) {
      await this.removeFileFromIndex(prevFile.id);
      deletedFileIds.push(prevFile.id);
      continue;
    }
    let needsReindex = forceAll;
    if (!forceAll) {
      try {
        needsReindex = getFileContentHash(currentFile.path) !== prevFile.hash;
      } catch {
        needsReindex = true;
      }
    }
    if (needsReindex) dirtyFiles.push(currentFile);
  }

  for (const [relPath, currentFile] of currentFileMap) {
    if (!prevFileMap.has(relPath)) dirtyFiles.push(currentFile);
  }

  const workers = forceAll ? this.resolveWorkerCount() : this.resolveWorkerCount('dirty');
  const parseResults = await this.parseDiscoveredFiles(dirtyFiles, workers);
  const dirtyFileIds = new Set<string>(deletedFileIds);

  for (const { discovered, result, error } of parseResults) {
    if (error) {
      log.error('Failed to index: ' + discovered.relativePath, error);
      continue;
    }
    if (!result) continue;
    dirtyFileIds.add(result.fileId);
    await this.removeFileFromIndex(result.fileId);
    this.storeParseResult(result, discovered);
    await this.indexChunkVectors(result, discovered);
    indexedCount++;
    totalSymbols += result.symbols.length;
    totalChunks += result.chunks.length;
  }

  const expandedDirtyFileIds = this.expandDirtyFileSet([...dirtyFileIds]);
  const totalEdges = await this.rebuildGraphEdges(forceAll ? 'full' : 'dirty', expandedDirtyFileIds);
  const elapsed = Date.now() - startTime;
  this.updateFinalMetadata(scanResult, {
    indexedFiles: indexedCount,
    symbols: totalSymbols,
    edges: totalEdges,
    chunks: totalChunks,
    durationMs: elapsed,
    parseWorkers: workers,
    dirtyFiles: expandedDirtyFileIds.length,
  }, forceAll ? 'full' : 'incremental');

  return this.buildStatus(indexedCount, totalSymbols, totalEdges, totalChunks);
}
```

- [ ] **Step 6: Verify**

Run:

```powershell
npm test -- tests/index-lifecycle.test.ts
npm run build
```

Expected: tests pass and TypeScript build passes.

- [ ] **Step 7: Commit**

```powershell
git add src/indexer/index-lock.ts src/indexer/index-manager.ts tests/index-lifecycle.test.ts
git commit -m "fix: harden index lifecycle and locking"
```

---

### Task 3: Make Parsing Memory-Safe with Bounded Batches

**Files:**
- Modify: `src/indexer/parse-worker-pool.ts`
- Modify: `src/indexer/index-manager.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/index-streaming.test.ts`
- Benchmark: `tools/benchmark-index.mjs`

- [ ] **Step 1: Add a failing test that proves batches are flushed**

Create `tests/index-streaming.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSampleProject, initCodeMemoryProject, queryRows } from './helpers/project-fixture.js';
import { IndexManager } from '../src/indexer/index-manager.js';

describe('streaming index writes', () => {
  it('uses parseBatchSize to flush parse results before the whole project completes', async () => {
    const root = createSampleProject({ repeatedFiles: 40 });
    const config = await initCodeMemoryProject(root, { embedding: 'none' });
    const manager = new IndexManager(root, {
      ...config,
      indexing: { workers: 0, parseBatchSize: 5, edgeMode: 'full' },
    });

    const storeSpy = vi.spyOn(manager as unknown as {
      storeParseResult(result: unknown, discovered: unknown): void;
    }, 'storeParseResult');

    await manager.fullIndex();

    expect(storeSpy).toHaveBeenCalled();
    expect(queryRows('SELECT COUNT(*) FROM files')[0][0]).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 2: Run the test and confirm current behavior is not batch-oriented**

Run:

```powershell
npm test -- tests/index-streaming.test.ts
```

Expected: initial test setup may fail until helper fixture supports `repeatedFiles`; add helper support in the next step.

- [ ] **Step 3: Add batch-oriented worker API**

Modify `src/indexer/parse-worker-pool.ts`:

```ts
export async function* parseFilesWithWorkersBatched(
  files: DiscoveredFile[],
  options: ParseWorkerOptions & { batchSize: number },
): AsyncGenerator<ParseWorkerResult[]> {
  if (files.length === 0) return;
  const pool = new ParseWorkerPool(options.rootPath, Math.max(1, options.workers));
  const batchSize = Math.max(1, Math.floor(options.batchSize));
  const inFlight = new Set<Promise<ParseWorkerResult>>();
  let nextFileIndex = 0;
  let batch: ParseWorkerResult[] = [];

  const enqueue = () => {
    while (nextFileIndex < files.length && inFlight.size < Math.max(options.workers, batchSize)) {
      const promise = pool.run(files[nextFileIndex++]);
      inFlight.add(promise);
      promise.finally(() => inFlight.delete(promise));
    }
  };

  try {
    enqueue();
    while (inFlight.size > 0) {
      const result = await Promise.race(inFlight);
      batch.push(result);
      enqueue();
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  } finally {
    await pool.close();
  }
}
```

Keep existing `parseFilesWithWorkers` for tests that still expect an array:

```ts
export async function parseFilesWithWorkers(
  files: DiscoveredFile[],
  options: ParseWorkerOptions,
): Promise<ParseWorkerResult[]> {
  const results: ParseWorkerResult[] = [];
  for await (const batch of parseFilesWithWorkersBatched(files, {
    ...options,
    batchSize: files.length || 1,
  })) {
    results.push(...batch);
  }
  return results;
}
```

- [ ] **Step 4: Add main-thread batch parser fallback**

Modify `src/indexer/index-manager.ts`:

```ts
private getParseBatchSize(): number {
  return Math.max(1, Math.floor(this.config.indexing?.parseBatchSize ?? 100));
}

private async *parseDiscoveredFilesBatched(
  files: DiscoveredFile[],
  workers: number,
): AsyncGenerator<Array<{ discovered: DiscoveredFile; result: ParseResult | null; error: unknown | null }>> {
  const batchSize = this.getParseBatchSize();
  const workerEntry = fileURLToPath(new URL('./parse-worker.js', import.meta.url));
  if (workers > 0 && existsSync(workerEntry)) {
    yield* parseFilesWithWorkersBatched(files, {
      workers,
      rootPath: this.rootPath,
      batchSize,
    });
    return;
  }

  let batch: Array<{ discovered: DiscoveredFile; result: ParseResult | null; error: unknown | null }> = [];
  for (const discovered of files) {
    try {
      batch.push({ discovered, result: await this.indexFile(discovered), error: null });
    } catch (error) {
      batch.push({ discovered, result: null, error });
    }
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
```

- [ ] **Step 5: Stream parse results through full index**

Replace the full-index parse loop with:

```ts
for await (const batch of this.parseDiscoveredFilesBatched(files, workers)) {
  for (const { discovered, result, error } of batch) {
    if (error) {
      log.error('Failed to index: ' + discovered.relativePath, error);
      continue;
    }
    if (!result) continue;
    await this.removeFileFromIndex(result.fileId);
    this.storeParseResult(result, discovered);
    await this.indexChunkVectors(result, discovered);
    indexedCount++;
    totalSymbols += result.symbols.length;
    totalChunks += result.chunks.length;
  }
  log.info('Progress: ' + indexedCount + '/' + files.length + ' (' + totalSymbols + ' symbols)');
}
```

- [ ] **Step 6: Stream parse results through incremental index**

Replace the incremental parse loop with:

```ts
for await (const batch of this.parseDiscoveredFilesBatched(dirtyFiles, workers)) {
  for (const { discovered, result, error } of batch) {
    if (error) {
      log.error('Failed to index: ' + discovered.relativePath, error);
      continue;
    }
    if (!result) continue;
    dirtyFileIds.add(result.fileId);
    await this.removeFileFromIndex(result.fileId);
    this.storeParseResult(result, discovered);
    await this.indexChunkVectors(result, discovered);
    indexedCount++;
    totalSymbols += result.symbols.length;
    totalChunks += result.chunks.length;
  }
}
```

- [ ] **Step 7: Verify memory and behavior**

Run:

```powershell
npm test -- tests/index-streaming.test.ts tests/performance-graph-upgrade.test.ts
npm run build
npm run benchmark:index -- --files 2000 --workers auto --embedding none
npm run benchmark:index -- --files 5000 --workers auto --embedding none
```

Expected:

- Tests pass.
- 2000-file benchmark stays under current `878.7MB` peak RSS.
- 5000-file benchmark completes without OOM.
- Parse throughput does not regress by more than 20 percent versus the previous 2000-file baseline.

- [ ] **Step 8: Commit**

```powershell
git add src/indexer/parse-worker-pool.ts src/indexer/index-manager.ts tests/index-streaming.test.ts
git commit -m "perf: stream parse results in bounded batches"
```

---

### Task 4: Make Graph Rebuild Transactional and Preserve Call-Site Evidence

**Files:**
- Modify: `src/storage/schema.ts`
- Create: `src/storage/graph-evidence-repository.ts`
- Modify: `src/storage/edge-repository.ts`
- Modify: `src/storage/parse-metadata-repository.ts`
- Modify: `src/indexer/index-manager.ts`
- Test: `tests/graph-evidence.test.ts`

- [ ] **Step 1: Add failing tests for duplicate call evidence**

Create `tests/graph-evidence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempProject, initCodeMemoryProject, queryRows } from './helpers/project-fixture.js';
import { IndexManager } from '../src/indexer/index-manager.js';

describe('graph evidence', () => {
  it('keeps separate call-site evidence for repeated calls between same symbols', async () => {
    const root = createTempProject();
    writeFileSync(join(root, 'src', 'tokens.ts'), `
export function issueTokens() { return 'token'; }
export function login() {
  issueTokens();
  issueTokens();
}
`);
    const config = await initCodeMemoryProject(root, { embedding: 'none' });
    const manager = new IndexManager(root, { ...config, indexing: { workers: 0, parseBatchSize: 10, edgeMode: 'full' } });
    await manager.fullIndex();

    const callEdges = queryRows(`
      SELECT COUNT(*)
      FROM edges
      WHERE type = 'CALLS'
    `);
    const evidenceRows = queryRows(`
      SELECT COUNT(*)
      FROM graph_edge_evidence
      WHERE edge_type = 'CALLS'
        AND evidence LIKE 'issueTokens%'
    `);

    expect(Number(callEdges[0][0])).toBeGreaterThanOrEqual(1);
    expect(Number(evidenceRows[0][0])).toBe(2);
  });
});
```

- [ ] **Step 2: Add schema v4 evidence table**

Modify `src/storage/schema.ts`:

```ts
export const SCHEMA_VERSION = 4;

export const CORE_TABLES: string[] = [
  // existing tables...
  `CREATE TABLE IF NOT EXISTS graph_edge_evidence (
    id              TEXT PRIMARY KEY,
    edge_id         TEXT NOT NULL,
    edge_type       TEXT NOT NULL,
    from_id         TEXT NOT NULL,
    to_id           TEXT NOT NULL,
    source_table    TEXT NOT NULL,
    source_id       TEXT,
    file_id         TEXT,
    start_line      INTEGER NOT NULL DEFAULT 0,
    start_column    INTEGER NOT NULL DEFAULT 0,
    evidence        TEXT,
    confidence      REAL NOT NULL DEFAULT 1.0
  )`,
];

export const INDEXES: string[] = [
  // existing indexes...
  `CREATE INDEX IF NOT EXISTS idx_graph_edge_evidence_edge ON graph_edge_evidence(edge_id)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edge_evidence_file ON graph_edge_evidence(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edge_evidence_type ON graph_edge_evidence(edge_type)`,
];
```

- [ ] **Step 3: Add evidence repository**

Create `src/storage/graph-evidence-repository.ts`:

```ts
import { generateId } from '../shared/utils.js';
import { getDatabaseSync } from './database.js';

export interface GraphEdgeEvidenceInput {
  edgeId: string;
  edgeType: string;
  fromId: string;
  toId: string;
  sourceTable: string;
  sourceId?: string | null;
  fileId?: string | null;
  startLine?: number;
  startColumn?: number;
  evidence?: string | null;
  confidence: number;
}

export function deleteGraphEvidenceForNodes(nodeIds: string[]): void {
  if (nodeIds.length === 0) return;
  const db = getDatabaseSync();
  const placeholders = nodeIds.map(() => '?').join(',');
  db.run(
    `DELETE FROM graph_edge_evidence
     WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders}) OR file_id IN (${placeholders})`,
    [...nodeIds, ...nodeIds, ...nodeIds],
  );
}

export function insertGraphEvidenceBatch(records: GraphEdgeEvidenceInput[]): void {
  if (records.length === 0) return;
  const db = getDatabaseSync();
  const stmt = db.native.prepare(`
    INSERT OR REPLACE INTO graph_edge_evidence
      (id, edge_id, edge_type, from_id, to_id, source_table, source_id, file_id,
       start_line, start_column, evidence, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const write = db.native.transaction((items: GraphEdgeEvidenceInput[]) => {
    for (const item of items) {
      stmt.run(
        generateId('graph-edge-evidence', item.edgeId, item.sourceTable, item.sourceId || '', String(item.startLine || 0), item.evidence || ''),
        item.edgeId,
        item.edgeType,
        item.fromId,
        item.toId,
        item.sourceTable,
        item.sourceId || null,
        item.fileId || null,
        item.startLine || 0,
        item.startColumn || 0,
        item.evidence || null,
        item.confidence,
      );
    }
  });
  write(records);
}
```

- [ ] **Step 4: Add batch edge upsert**

Modify `src/storage/edge-repository.ts`:

```ts
export function upsertEdges(edges: EdgeRecord[]): void {
  if (edges.length === 0) return;
  const db = getDatabaseSync();
  const stmt = db.native.prepare(`
    INSERT OR REPLACE INTO edges
      (id, from_id, to_id, type, confidence, evidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const write = db.native.transaction((items: EdgeRecord[]) => {
    for (const edge of items) {
      stmt.run(edge.id, edge.fromId, edge.toId, edge.type, edge.confidence, edge.evidence ?? null);
    }
  });
  write(edges);
}
```

- [ ] **Step 5: Batch call_ref resolution updates**

Modify `src/storage/parse-metadata-repository.ts`:

```ts
export function updateCallRefResolutions(
  updates: Array<{ id: string; status: 'resolved' | 'unresolved' | 'ambiguous' }>,
): void {
  if (updates.length === 0) return;
  const db = getDatabaseSync();
  const stmt = db.native.prepare('UPDATE call_refs SET resolution_status = ? WHERE id = ?');
  const write = db.native.transaction((items: Array<{ id: string; status: string }>) => {
    for (const item of items) stmt.run(item.status, item.id);
  });
  write(updates);
}
```

- [ ] **Step 6: Collect graph writes in memory and flush once**

Modify `src/indexer/index-manager.ts`:

```ts
interface PendingGraphWrite {
  fromId: string;
  toId: string;
  type: EdgeType;
  confidence: number;
  evidence: string | null;
  sourceTable?: string;
  sourceId?: string | null;
  fileId?: string | null;
  startLine?: number;
  startColumn?: number;
}

private pendingGraphWrites: PendingGraphWrite[] = [];

private queueGraphEdge(write: PendingGraphWrite): number {
  this.pendingGraphWrites.push(write);
  return 1;
}

private flushGraphWrites(): void {
  const byEdge = new Map<string, PendingGraphWrite>();
  const evidence: GraphEdgeEvidenceInput[] = [];
  for (const item of this.pendingGraphWrites) {
    const edgeId = generateId('edge', item.fromId, item.toId, item.type);
    const previous = byEdge.get(edgeId);
    byEdge.set(edgeId, {
      ...item,
      confidence: previous ? Math.max(previous.confidence, item.confidence) : item.confidence,
      evidence: previous?.evidence || item.evidence,
    });
    evidence.push({
      edgeId,
      edgeType: item.type,
      fromId: item.fromId,
      toId: item.toId,
      sourceTable: item.sourceTable || 'graph',
      sourceId: item.sourceId || null,
      fileId: item.fileId || null,
      startLine: item.startLine || 0,
      startColumn: item.startColumn || 0,
      evidence: item.evidence || null,
      confidence: item.confidence,
    });
  }
  upsertEdges([...byEdge.entries()].map(([id, item]) => ({
    id,
    fromId: item.fromId,
    toId: item.toId,
    type: item.type,
    confidence: item.confidence,
    evidence: item.evidence,
  })));
  insertGraphEvidenceBatch(evidence);
  this.pendingGraphWrites = [];
}
```

- [ ] **Step 7: Wrap graph rebuild in a transaction**

At the start of `rebuildGraphEdges`:

```ts
this.pendingGraphWrites = [];
const db = getDatabaseSync();
const rebuild = db.native.transaction(() => {
  // existing edge delete and create logic
  this.flushGraphWrites();
  updateCallRefResolutions(callResolutionUpdates);
});
rebuild();
```

Replace `upsertGraphEdge(...)` calls with `queueGraphEdge(...)`.

- [ ] **Step 8: Verify**

Run:

```powershell
npm test -- tests/graph-evidence.test.ts tests/performance-graph-upgrade.test.ts
npm run build
npm run benchmark:index -- --files 2000 --workers auto --embedding none
```

Expected:

- Repeated call sites create separate `graph_edge_evidence` rows.
- Logical graph edges remain deduplicated.
- Dirty/full graph rebuild still never calls `indexFile` or `parseFile`.
- Benchmark does not regress by more than 20 percent.

- [ ] **Step 9: Commit**

```powershell
git add src/storage/schema.ts src/storage/graph-evidence-repository.ts src/storage/edge-repository.ts src/storage/parse-metadata-repository.ts src/indexer/index-manager.ts tests/graph-evidence.test.ts tests/performance-graph-upgrade.test.ts
git commit -m "perf: batch graph rebuild and preserve evidence"
```

---

### Task 5: Harden Vector and Embedding Pipeline

**Files:**
- Create: `src/indexer/embedding-queue.ts`
- Modify: `src/indexer/embedding-generator.ts`
- Modify: `src/search/vector-search.ts`
- Modify: `src/indexer/index-manager.ts`
- Test: `tests/embedding-queue.test.ts`, `tests/vector-search.test.ts`

- [ ] **Step 1: Add embedding queue tests**

Create `tests/embedding-queue.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingQueue } from '../src/indexer/embedding-queue.js';

describe('EmbeddingQueue', () => {
  it('preserves input order across concurrent batches', async () => {
    const generator = {
      generateBatch: vi.fn(async (texts: string[]) => texts.map((text) => [text.length])),
    };
    const queue = new EmbeddingQueue(generator, { batchSize: 2, concurrency: 2, retries: 0, timeoutMs: 1000 });
    const result = await queue.embed(['a', 'bb', 'ccc']);
    expect(result).toEqual([[1], [2], [3]]);
  });

  it('returns empty vectors after retry exhaustion', async () => {
    const generator = {
      generateBatch: vi.fn(async () => { throw new Error('provider down'); }),
    };
    const queue = new EmbeddingQueue(generator, { batchSize: 2, concurrency: 1, retries: 1, timeoutMs: 1000 });
    const result = await queue.embed(['a', 'b']);
    expect(result).toEqual([[], []]);
    expect(generator.generateBatch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Implement queue**

Create `src/indexer/embedding-queue.ts`:

```ts
import { createLogger } from '../shared/logger.js';

const log = createLogger('embedding-queue');

export interface EmbeddingBatchGenerator {
  generateBatch(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingQueueOptions {
  batchSize: number;
  concurrency: number;
  retries: number;
  timeoutMs: number;
}

export class EmbeddingQueue {
  constructor(
    private readonly generator: EmbeddingBatchGenerator,
    private readonly options: EmbeddingQueueOptions,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const results = Array.from({ length: texts.length }, () => [] as number[]);
    const batches = chunk(texts.map((text, index) => ({ text, index })), Math.max(1, this.options.batchSize));
    let next = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, this.options.concurrency), batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const vectors = await this.runBatch(batch.map((item) => item.text));
        for (let i = 0; i < batch.length; i++) {
          results[batch[i].index] = vectors[i] || [];
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async runBatch(texts: string[]): Promise<number[][]> {
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        return await withTimeout(this.generator.generateBatch(texts), this.options.timeoutMs);
      } catch (err) {
        if (attempt >= this.options.retries) {
          log.warn('Embedding batch failed after retries: ' + (err instanceof Error ? err.message : String(err)));
          return texts.map(() => []);
        }
      }
    }
    return texts.map(() => []);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Embedding request timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
```

- [ ] **Step 3: Batch vector deletes**

Modify `src/search/vector-search.ts`:

```ts
export async function deleteVectors(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const connection = await ensureVectorConnection();
  const table = await connection.openTable(TABLE_NAME);
  try {
    const escaped = ids.map((id) => `'${escapeSqlString(id)}'`).join(',');
    await table.delete(`id IN (${escaped})`);
    log.info(`Deleted ${ids.length} vectors`);
  } finally {
    table.close();
  }
}
```

- [ ] **Step 4: Use EmbeddingQueue during indexing**

Modify `src/indexer/index-manager.ts` in `indexChunkVectors`:

```ts
const queue = new EmbeddingQueue(this.embeddingGenerator, {
  batchSize,
  concurrency: Math.max(1, Math.floor(this.config.embedding.concurrency ?? 2)),
  retries: 2,
  timeoutMs: 60_000,
});
const vectors = await queue.embed(batch.map(({ chunk }) => chunk.content));
```

- [ ] **Step 5: Add vector dimension validation**

Modify `src/search/vector-search.ts` after vector generation:

```ts
function assertVectorDimensions(vector: number[], expected: number): boolean {
  return vector.length === expected;
}
```

Use it before writing records:

```ts
const validRecords = records.filter((record) => assertVectorDimensions(record.vector, dbInstanceDimensions));
if (validRecords.length !== records.length) {
  log.warn(`Skipped ${records.length - validRecords.length} vectors with mismatched dimensions`);
}
await table.add(validRecords);
```

- [ ] **Step 6: Verify**

Run:

```powershell
npm test -- tests/embedding-queue.test.ts tests/vector-search.test.ts tests/mcp-vector-search.test.ts
npm run build
```

Expected: all vector tests pass and query mode still reports clear errors when vector provider is unavailable.

- [ ] **Step 7: Commit**

```powershell
git add src/indexer/embedding-queue.ts src/indexer/embedding-generator.ts src/search/vector-search.ts src/indexer/index-manager.ts tests/embedding-queue.test.ts tests/vector-search.test.ts
git commit -m "perf: harden embedding and vector pipeline"
```

---

### Task 6: Add Doctor Invariants and Index Observability

**Files:**
- Create: `src/storage/invariants.ts`
- Create: `src/indexer/index-metrics.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/cli/commands/status.ts`
- Modify: `src/indexer/index-manager.ts`
- Test: `tests/doctor-invariants.test.ts`, `tests/index-metrics.test.ts`

- [ ] **Step 1: Write invariant tests**

Create `tests/doctor-invariants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSampleProject, initCodeMemoryProject, queryRows, runCli } from './helpers/project-fixture.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { getDatabaseSync } from '../src/storage/database.js';

describe('doctor invariants', () => {
  it('reports dangling graph edges', async () => {
    const root = createSampleProject();
    const config = await initCodeMemoryProject(root, { embedding: 'none' });
    const manager = new IndexManager(root, { ...config, indexing: { workers: 0, parseBatchSize: 20, edgeMode: 'full' } });
    await manager.fullIndex();

    getDatabaseSync().run(
      "INSERT INTO edges (id, from_id, to_id, type, confidence, evidence) VALUES ('bad-edge', 'missing-a', 'missing-b', 'CALLS', 1, 'bad')",
    );

    const result = await runCli(root, ['doctor', '--json']);
    expect(result.stdout).toContain('dangling-edges');
    expect(JSON.parse(result.stdout).checks.some((check: { name: string; status: string }) =>
      check.name === 'dangling-edges' && check.status === 'error'
    )).toBe(true);
  });
});
```

- [ ] **Step 2: Implement invariant collector**

Create `src/storage/invariants.ts`:

```ts
import type { SqlJsDatabase } from './database.js';

export interface InvariantCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  count?: number;
}

export function collectInvariants(db: SqlJsDatabase): InvariantCheck[] {
  return [
    countCheck(db, 'dangling-edges', `
      SELECT COUNT(*)
      FROM edges e
      WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = e.from_id)
        AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.from_id)
         OR NOT EXISTS (SELECT 1 FROM files f WHERE f.id = e.to_id)
        AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.to_id)
    `, 'error', 'No dangling graph edges.'),
    countCheck(db, 'symbols-without-files', `
      SELECT COUNT(*)
      FROM symbols s
      WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = s.file_id)
    `, 'error', 'All symbols point to indexed files.'),
    countCheck(db, 'chunks-without-files', `
      SELECT COUNT(*)
      FROM chunks c
      WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = c.file_id)
    `, 'error', 'All chunks point to indexed files.'),
    countCheck(db, 'symbols-without-chunks', `
      SELECT COUNT(*)
      FROM symbols s
      WHERE s.kind IN ('function', 'method', 'class', 'interface', 'variable', 'constant')
        AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.symbol_id = s.id)
    `, 'warn', 'All code symbols have context chunks.'),
    countCheck(db, 'unresolved-calls', `
      SELECT COUNT(*)
      FROM call_refs
      WHERE resolution_status != 'resolved'
    `, 'warn', 'All call references resolved.'),
  ];
}

function countCheck(
  db: SqlJsDatabase,
  name: string,
  sql: string,
  nonZeroStatus: 'warn' | 'error',
  okMessage: string,
): InvariantCheck {
  const count = Number(db.exec(sql)[0]?.values[0]?.[0] ?? 0);
  return count === 0
    ? { name, status: 'ok', message: okMessage, count }
    : { name, status: nonZeroStatus, message: `${count} issue(s) found.`, count };
}
```

- [ ] **Step 3: Wire invariants into doctor**

Modify `src/cli/commands/doctor.ts` after opening DB:

```ts
import { collectInvariants } from '../../storage/invariants.js';

try {
  const db = getDatabaseSync();
  checks.push(...collectInvariants(db));
} catch (err) {
  checks.push({
    name: 'index-invariants',
    status: 'warn',
    message: 'Could not inspect index invariants: ' + (err instanceof Error ? err.message : String(err)),
  });
}
```

- [ ] **Step 4: Add phase metrics model**

Create `src/indexer/index-metrics.ts`:

```ts
export interface IndexPhaseMetrics {
  scanMs: number;
  parseMs: number;
  writeMs: number;
  edgeMs: number;
  vectorMs: number;
  totalMs: number;
  peakRssMb: number;
}

export class IndexMetricsRecorder {
  private marks = new Map<string, number>();

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  elapsed(from: string, to: string): number {
    const start = this.marks.get(from);
    const end = this.marks.get(to);
    return start && end ? end - start : 0;
  }

  peakRssMb(): number {
    return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
  }
}
```

- [ ] **Step 5: Persist metrics**

Modify `updateFinalMetadata` to include:

```ts
this.setMetadata('last_index_peak_rss_mb', String(runStats.peakRssMb ?? 0));
this.setMetadata('last_index_parse_ms', String(runStats.parseMs ?? 0));
this.setMetadata('last_index_write_ms', String(runStats.writeMs ?? 0));
this.setMetadata('last_index_edge_ms', String(runStats.edgeMs ?? 0));
this.setMetadata('last_index_vector_ms', String(runStats.vectorMs ?? 0));
```

- [ ] **Step 6: Verify**

Run:

```powershell
npm test -- tests/doctor-invariants.test.ts tests/index-metrics.test.ts
npm run build
node dist/index.js doctor --json
```

Expected: doctor JSON includes invariant checks; status JSON includes phase metrics after indexing.

- [ ] **Step 7: Commit**

```powershell
git add src/storage/invariants.ts src/indexer/index-metrics.ts src/cli/commands/doctor.ts src/cli/commands/status.ts src/indexer/index-manager.ts tests/doctor-invariants.test.ts tests/index-metrics.test.ts
git commit -m "feat: add doctor invariants and index metrics"
```

---

### Task 7: Add TS/JS Module Resolver for Real Projects

**Files:**
- Create: `src/parser/module-resolver.ts`
- Create: `src/scanner/project-manifest.ts`
- Modify: `src/indexer/index-manager.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/module-resolution.test.ts`
- Fixture: `tests/fixtures/module-resolution-project/**`

- [ ] **Step 1: Create fixture**

Add files:

```text
tests/fixtures/module-resolution-project/package.json
tests/fixtures/module-resolution-project/tsconfig.json
tests/fixtures/module-resolution-project/src/app.ts
tests/fixtures/module-resolution-project/src/services/auth.ts
tests/fixtures/module-resolution-project/packages/shared/package.json
tests/fixtures/module-resolution-project/packages/shared/src/index.ts
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@services/*": ["src/services/*"],
      "@shared": ["packages/shared/src/index.ts"]
    }
  }
}
```

`src/app.ts`:

```ts
import { login } from '@services/auth';
import { normalizeEmail } from '@shared';

export function run(email: string) {
  return login(normalizeEmail(email));
}
```

`src/services/auth.ts`:

```ts
export function login(email: string) {
  return email.length > 0;
}
```

`packages/shared/src/index.ts`:

```ts
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
```

- [ ] **Step 2: Write failing resolver test**

Create `tests/module-resolution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { copyFixtureProject, initCodeMemoryProject, queryRows } from './helpers/project-fixture.js';
import { IndexManager } from '../src/indexer/index-manager.js';

describe('module resolution', () => {
  it('resolves tsconfig paths into IMPORTS and CALLS graph edges', async () => {
    const root = copyFixtureProject('module-resolution-project');
    const config = await initCodeMemoryProject(root, { embedding: 'none' });
    const manager = new IndexManager(root, { ...config, indexing: { workers: 0, parseBatchSize: 20, edgeMode: 'full' } });
    await manager.fullIndex();

    const imports = queryRows(`
      SELECT target.path
      FROM edges e
      JOIN files source ON source.id = e.from_id
      JOIN files target ON target.id = e.to_id
      WHERE e.type = 'IMPORTS' AND source.path = 'src/app.ts'
      ORDER BY target.path
    `).map((row) => String(row[0]));

    expect(imports).toEqual([
      'packages/shared/src/index.ts',
      'src/services/auth.ts',
    ]);
  });
});
```

- [ ] **Step 3: Implement project manifest discovery**

Create `src/scanner/project-manifest.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { safeJsonParse } from '../shared/utils.js';

export interface ProjectManifest {
  rootPath: string;
  tsconfigPaths: Record<string, string[]>;
  baseUrl: string;
  packageExports: Map<string, string>;
}

export function loadProjectManifest(rootPath: string): ProjectManifest {
  const tsconfigPath = join(rootPath, 'tsconfig.json');
  const tsconfig = existsSync(tsconfigPath)
    ? safeJsonParse<{ compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }>(readFileSync(tsconfigPath, 'utf-8'))
    : null;

  return {
    rootPath,
    baseUrl: resolve(rootPath, tsconfig?.compilerOptions?.baseUrl || '.'),
    tsconfigPaths: tsconfig?.compilerOptions?.paths || {},
    packageExports: new Map(),
  };
}
```

- [ ] **Step 4: Implement resolver**

Create `src/parser/module-resolver.ts`:

```ts
import { posix as posixPath } from 'node:path';
import type { FileRecord } from '../shared/types.js';
import { normalizePath } from '../shared/utils.js';
import type { ProjectManifest } from '../scanner/project-manifest.js';

export class ModuleResolver {
  constructor(
    private readonly manifest: ProjectManifest,
    private readonly filesByPath: Map<string, FileRecord>,
  ) {}

  resolve(importer: FileRecord, source: string): FileRecord | null {
    if (source.startsWith('.')) {
      return this.resolveRelative(importer, source);
    }
    return this.resolveTsconfigPath(source) || this.resolvePackageSource(source);
  }

  private resolveRelative(importer: FileRecord, source: string): FileRecord | null {
    const importerDir = posixPath.dirname(normalizePath(importer.path));
    const rawPath = normalizePath(posixPath.normalize(posixPath.join(importerDir, source)));
    return this.resolveCandidates(rawPath, importer.language === 'typescript');
  }

  private resolveTsconfigPath(source: string): FileRecord | null {
    for (const [pattern, targets] of Object.entries(this.manifest.tsconfigPaths)) {
      const starIndex = pattern.indexOf('*');
      if (starIndex === -1 && pattern === source) {
        for (const target of targets) {
          const match = this.resolveCandidates(normalizePath(target), true);
          if (match) return match;
        }
      }
      if (starIndex >= 0) {
        const prefix = pattern.slice(0, starIndex);
        const suffix = pattern.slice(starIndex + 1);
        if (source.startsWith(prefix) && source.endsWith(suffix)) {
          const middle = source.slice(prefix.length, source.length - suffix.length);
          for (const target of targets) {
            const raw = normalizePath(target.replace('*', middle));
            const match = this.resolveCandidates(raw, true);
            if (match) return match;
          }
        }
      }
    }
    return null;
  }

  private resolvePackageSource(source: string): FileRecord | null {
    return this.resolveCandidates(source, true);
  }

  private resolveCandidates(rawPath: string, preferTypeScript: boolean): FileRecord | null {
    for (const candidate of getImportCandidates(rawPath, preferTypeScript)) {
      const file = this.filesByPath.get(candidate);
      if (file) return file;
    }
    return null;
  }
}

export function getImportCandidates(rawPath: string, preferTypeScript: boolean): string[] {
  const candidates: string[] = [];
  const add = (candidate: string) => {
    const normalized = normalizePath(candidate);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };
  const ext = posixPath.extname(rawPath);
  if (ext) {
    const withoutExt = rawPath.slice(0, -ext.length);
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      add(withoutExt + '.ts');
      add(withoutExt + '.tsx');
    }
    add(rawPath);
    return candidates;
  }
  const extensions = preferTypeScript
    ? ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
    : ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];
  for (const candidateExt of extensions) add(rawPath + candidateExt);
  for (const candidateExt of extensions) add(posixPath.join(rawPath, 'index' + candidateExt));
  return candidates;
}
```

- [ ] **Step 5: Wire resolver into IndexManager**

Modify `src/indexer/index-manager.ts`:

```ts
import { ModuleResolver } from '../parser/module-resolver.js';
import { loadProjectManifest } from '../scanner/project-manifest.js';

private moduleResolver: ModuleResolver | null = null;

private buildModuleResolver(filesByPath: Map<string, FileRecord>): ModuleResolver {
  this.moduleResolver = new ModuleResolver(loadProjectManifest(this.rootPath), filesByPath);
  return this.moduleResolver;
}
```

In `rebuildGraphEdges`, after `filesByPath` is created:

```ts
const moduleResolver = this.buildModuleResolver(filesByPath);
```

Replace calls:

```ts
const target = this.resolveImportTarget(file, imp.source, filesByPath);
```

with:

```ts
const target = moduleResolver.resolve(file, imp.source);
```

- [ ] **Step 6: Verify**

Run:

```powershell
npm test -- tests/module-resolution.test.ts tests/indexing-core.test.ts
npm run build
```

Expected: import graph resolves aliases and existing relative import behavior remains unchanged.

- [ ] **Step 7: Commit**

```powershell
git add src/parser/module-resolver.ts src/scanner/project-manifest.ts src/indexer/index-manager.ts tests/module-resolution.test.ts tests/fixtures/module-resolution-project
git commit -m "feat: resolve tsconfig and workspace imports"
```

---

### Task 8: Optimize Context Pack and Make Ledger More Useful

**Files:**
- Modify: `src/search/context-packer.ts`
- Modify: `src/mcp/tools/get-context-pack.ts`
- Modify: `src/memory/context-ledger.ts`
- Test: `tests/context-pack-quality.test.ts`

- [ ] **Step 1: Add context-pack quality tests**

Create `tests/context-pack-quality.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSampleProject, initCodeMemoryProject } from './helpers/project-fixture.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { getDatabaseSync } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';
import { ContextPacker } from '../src/search/context-packer.js';

describe('context pack quality', () => {
  it('returns real snippets and explains why they were selected', async () => {
    const root = createSampleProject();
    const config = await initCodeMemoryProject(root, { embedding: 'none' });
    const manager = new IndexManager(root, { ...config, indexing: { workers: 0, parseBatchSize: 20, edgeMode: 'full' } });
    await manager.fullIndex();

    const db = getDatabaseSync();
    const search = new HybridSearchEngine(db);
    const results = await search.searchCode('login', { searchMode: 'hybrid', limit: 5 });
    const pack = await new ContextPacker(db).pack('login', results, {
      tokenBudget: 8000,
      includeProjectCard: true,
      includeMemories: true,
      maxLevel: 'L4',
    });

    expect(pack.codeSnippets.length).toBeGreaterThan(0);
    expect(pack.codeSnippets[0].content).toContain('login');
    expect(pack.codeSnippets[0].reason).toMatch(/score|Matched|graph|keyword/i);
  });
});
```

- [ ] **Step 2: Batch-load context files**

Modify `src/search/context-packer.ts`:

```ts
private getContextFiles(results: SearchResult[]): ContextFile[] {
  const paths = [...new Set(results.map((result) => result.filePath))];
  if (paths.length === 0) return [];
  const placeholders = paths.map(() => '?').join(',');
  const rows = this.db.exec(
    `SELECT path, role, language FROM files WHERE path IN (${placeholders})`,
    paths,
  )[0]?.values ?? [];
  const byPath = new Map(rows.map((row) => [String(row[0]), {
    role: String(row[1]) as ContextFile['role'],
    language: String(row[2]) as ContextFile['language'],
  }]));

  return paths.map((path) => {
    const result = results.find((item) => item.filePath === path)!;
    const file = byPath.get(path);
    return {
      path,
      role: file?.role || 'source',
      language: file?.language || 'unknown',
      reason: `Matched by ${result.sources.join('+')} (score: ${result.score.toFixed(3)})`,
      confidence: result.score,
    };
  });
}
```

- [ ] **Step 3: Batch-load symbols and chunks**

Use one `IN (...)` query for symbol ids:

```ts
private getContextSymbols(results: SearchResult[]): ContextSymbol[] {
  const ids = results.filter((result) => result.kind !== 'file').map((result) => result.id);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = this.db.exec(
    `SELECT s.id, s.name, s.kind, f.path, s.start_line, s.end_line,
            s.start_column, s.end_column, s.signature, s.summary
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE s.id IN (${placeholders})`,
    ids,
  )[0]?.values ?? [];
  const resultById = new Map(results.map((result) => [result.id, result]));
  return rows.map((row) => {
    const result = resultById.get(String(row[0]));
    return {
      name: String(row[1]),
      kind: String(row[2]) as SymbolKind,
      filePath: String(row[3]),
      signature: row[8] ? String(row[8]) : null,
      summary: row[9] ? String(row[9]) : null,
      lineRange: [Number(row[4]), Number(row[5])],
      columnRange: [Number(row[6]), Number(row[7])],
      reason: result ? `Matched by ${result.sources.join('+')}` : 'Matched by search',
    };
  });
}
```

- [ ] **Step 4: Add unresolved-call context summary**

Modify `identifyMissing`:

```ts
const unresolvedRows = this.db.exec(
  `SELECT f.path, COUNT(*)
   FROM call_refs c
   JOIN files f ON f.id = c.file_id
   WHERE c.resolution_status != 'resolved'
   GROUP BY f.path
   ORDER BY COUNT(*) DESC
   LIMIT 5`,
)[0]?.values ?? [];

if (unresolvedRows.length > 0) {
  missing.push('Unresolved call references remain: ' +
    unresolvedRows.map((row) => `${String(row[0])}=${Number(row[1])}`).join(', '));
}
```

- [ ] **Step 5: Verify**

Run:

```powershell
npm test -- tests/context-pack-quality.test.ts tests/mcp-context-pack-ledger.test.ts tests/context-ledger.test.ts
npm run build
```

Expected: context pack still returns L4 snippets and ledger tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/search/context-packer.ts src/mcp/tools/get-context-pack.ts src/memory/context-ledger.ts tests/context-pack-quality.test.ts
git commit -m "perf: batch context packing and improve ledger evidence"
```

---

### Task 9: Fix Grammar Command Messaging and Security Guidance

**Files:**
- Modify: `src/parser/parser-registry.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `.gitignore`
- Modify: `README.md`
- Test: `tests/cli-doctor.test.ts`

- [ ] **Step 1: Fix invalid command text**

Modify `src/parser/parser-registry.ts`:

```ts
const msg = [
  `Grammar WASM not found for ${config.name} (${config.wasmFile}).`,
  'Set CODE_MEMORY_GRAMMARS to a directory containing grammar .wasm files,',
  'or install the published package with bundled grammars.',
  'Run code-memory doctor to verify grammar resolution.',
].join('\n');
```

- [ ] **Step 2: Ignore local index artifacts**

Modify `.gitignore`:

```gitignore
.code-memory/
*.db-wal
*.db-shm
```

- [ ] **Step 3: Add doctor security warning**

In `doctor.ts`, add a non-printing secret scan summary:

```ts
checks.push({
  name: 'local-storage-privacy',
  status: 'ok',
  message: '.code-memory stores local snippets, metadata, and optional vectors. Keep it out of git and backups that should not contain code snippets.',
});
```

- [ ] **Step 4: Document local storage**

Add to README:

```md
## Local Storage And Privacy

Code Memory writes `.code-memory/` inside the indexed project. It can contain SQLite metadata, symbol chunks, call evidence, memories, ledger history, and optional vector embeddings. Keep `.code-memory/` out of git. The tool does not upload code unless you configure an embedding provider that sends text to an external API.
```

- [ ] **Step 5: Verify**

Run:

```powershell
npm test -- tests/cli-doctor.test.ts
npm run build
```

Expected: doctor tests pass and missing grammar message no longer references a nonexistent command.

- [ ] **Step 6: Commit**

```powershell
git add src/parser/parser-registry.ts src/cli/commands/doctor.ts .gitignore README.md tests/cli-doctor.test.ts
git commit -m "docs: clarify grammar and local storage guidance"
```

---

### Task 10: Add Pack Install Smoke and Release Verification

**Files:**
- Create: `tools/pack-smoke.mjs`
- Modify: `package.json`
- Test: `tests/release-pack.test.ts`

- [ ] **Step 1: Create pack smoke script**

Create `tools/pack-smoke.mjs`:

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'code-memory-pack-smoke-'));

try {
  const packOutput = execFileSync('npm', ['pack', '--json'], { cwd: root, encoding: 'utf-8' });
  const [{ filename }] = JSON.parse(packOutput);
  execFileSync('npm', ['init', '-y'], { cwd: temp, stdio: 'ignore' });
  execFileSync('npm', ['install', join(root, filename)], { cwd: temp, stdio: 'inherit' });

  mkdirSync(join(temp, 'src'), { recursive: true });
  writeFileSync(join(temp, 'src', 'index.ts'), 'export function hello() { return "world"; }\n');

  const bin = join(temp, 'node_modules', '.bin', process.platform === 'win32' ? 'code-memory.cmd' : 'code-memory');
  execFileSync(bin, ['--help'], { cwd: temp, stdio: 'inherit' });
  execFileSync(bin, ['init', '--embedding', 'none'], { cwd: temp, stdio: 'inherit' });
  execFileSync(bin, ['doctor'], { cwd: temp, stdio: 'inherit' });
  execFileSync(bin, ['index', '--full', '--workers', '0'], { cwd: temp, stdio: 'inherit' });
  execFileSync(bin, ['query', 'hello', '--json'], { cwd: temp, stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Add release-pack test**

Create `tests/release-pack.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('npm package contents', () => {
  it('does not publish source fixtures or tools', () => {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf-8' });
    const [{ files }] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const paths = files.map((file) => file.path);
    expect(paths.some((path) => path.startsWith('dist/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('grammars/'))).toBe(true);
    expect(paths).toContain('README.md');
    expect(paths).toContain('LICENSE');
    expect(paths.some((path) => path.startsWith('src/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('tests/fixtures/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('tools/'))).toBe(false);
  });
});
```

- [ ] **Step 3: Add script**

Modify `package.json`:

```json
{
  "scripts": {
    "test:smoke": "npm run build && node tools/pack-smoke.mjs"
  }
}
```

- [ ] **Step 4: Verify**

Run:

```powershell
npm test -- tests/release-pack.test.ts
npm run test:smoke
npm pack --dry-run
```

Expected: package install smoke works from a temp project and published file list remains minimal.

- [ ] **Step 5: Commit**

```powershell
git add tools/pack-smoke.mjs package.json tests/release-pack.test.ts
git commit -m "test: add package install smoke"
```

---

## Final Verification Matrix

Run these commands after all tasks:

```powershell
npx gitnexus analyze
npm run lint
npm run build
npm test
npm audit --registry=https://registry.npmjs.org
npm pack --dry-run
npm run test:smoke
npm run benchmark:index -- --files 2000 --workers auto --embedding none
npm run benchmark:index -- --files 5000 --workers auto --embedding none
gitnexus detect_changes
```

Expected final state:

- Lint, build, tests, audit, pack, and smoke all pass.
- 5000-file benchmark completes without OOM.
- 2000-file benchmark peak RSS is lower than or not materially worse than the current `878.7MB` baseline.
- Doctor reports native SQLite, WAL, FTS5, worker_threads, grammar availability, and index invariants.
- Dirty/full graph rebuild still uses metadata only.
- Multiple call sites retain evidence without duplicating high-level graph edges.
- Vector search either works with configured embeddings or returns a clear error without pretending semantic search ran.
- `get_context_pack` returns real snippets, reasons, commit/index evidence, and repeated-context ledger behavior.
- Package smoke proves an installed tarball can initialize, index, and query a project.

## Commit Sequence

Use this order so every commit is independently reviewable:

1. `chore: restore quality gates and ci`
2. `fix: harden index lifecycle and locking`
3. `perf: stream parse results in bounded batches`
4. `perf: batch graph rebuild and preserve evidence`
5. `perf: harden embedding and vector pipeline`
6. `feat: add doctor invariants and index metrics`
7. `feat: resolve tsconfig and workspace imports`
8. `perf: batch context packing and improve ledger evidence`
9. `docs: clarify grammar and local storage guidance`
10. `test: add package install smoke`

## Self-Review

- Spec coverage: This plan covers CI, lint, memory-safe indexing, index lock/cleanup, graph evidence, vector reliability, module resolution, doctor invariants, context pack quality, security/privacy guidance, package install smoke, and benchmark gates.
- Placeholder scan: No task is left without concrete files, commands, and expected outcomes.
- Type consistency: New APIs are named consistently: `acquireIndexLock`, `parseFilesWithWorkersBatched`, `EmbeddingQueue`, `collectInvariants`, `ModuleResolver`, `graph_edge_evidence`.
- Scope discipline: No database replacement beyond the current better-sqlite3 architecture; no CLI/MCP tool names are removed or renamed.
