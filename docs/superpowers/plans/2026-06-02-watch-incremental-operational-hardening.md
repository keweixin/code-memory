# Watch Incremental and Operational Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for single-agent execution, or `superpowers:subagent-driven-development` if splitting independent test, CLI, and indexing tasks. Track every task with the checkbox status below.

**Goal:** Turn the current productized prototype into a more reliable local Context Governor by fixing the highest-risk operational gaps identified in `C:/Users/Administrator/Downloads/deep-research-report.md`: watch mode must be path-aware, configured ignores must apply to file watching, `serve` errors must be scriptable, secrets must not be encouraged in plaintext config, coverage must become a quality gate, and hot-path modules need a safe refactor path.

**Architecture:** Preserve the existing architecture: `better-sqlite3 + FTS5 + optional LanceDB + worker_threads + MCP tools`. Do not replace the storage engine, graph model, or public CLI/MCP tool names. Implement this as a hardening sequence with regression tests first, then targeted behavior changes, then behavior-preserving refactors.

**Current Local Baseline:** The local working tree already contains uncommitted implementation work around repo-aware vector routing, native SQLite/FTS5, worker batch indexing, lifecycle metadata, doctor deep checks, package export resolver, Ledger fill-after-omit, RRF score breakdown, and Vitest 4 compatibility. Do not commit unless the user later asks. Do not revert unrelated dirty files.

**Non-Goals For This Plan:**
- No GitHub push, commit, or tag.
- No new graph database.
- No cloud sync.
- No broad language expansion before TS/JS watch and resolver reliability are locked down.
- No user-visible CLI/MCP breaking changes unless the current flag is dead or misleading.

---

## Phase 0: Baseline Audit And Failing Contracts

**Purpose:** Lock the report findings into executable tests before changing behavior. These tests should prove the current risk and protect against regressions.

### Task 0.1: Add Watch Contract Tests

- [x] Locate existing watch/index tests before adding new files.
- [x] Add or extend a watch service test that proves configured ignore patterns are honored.
- [x] Add a test that a changed file path is forwarded from the watcher to the indexer.
- [x] Add a test for unlink/delete events forwarding the deleted path.
- [x] Use temp directories and short debounce windows; do not rely on real project files.

Expected files:
- `tests/watch-service.test.ts` or nearest existing watch test.
- `src/indexer/watch-service.ts` only after tests are in place.

Acceptance:
- Before implementation, at least one test should fail because `watch-service.ts` currently uses hardcoded ignore rules and calls `manager.incrementalIndex()` without changed paths.
- After implementation, ignored files do not schedule indexing and nonignored files pass normalized paths to the index manager.

Verification:

```powershell
npm test -- tests/watch-service.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

### Task 0.2: Add Incremental Index Contract Tests

- [x] Add a test proving path-aware incremental indexing does not call the full project scanner for a single file change.
- [x] Add a test proving deleted files clean up file, symbols, chunks, edges, edge evidence, parse metadata, vector refs, and stale ledger references.
- [x] Add a test proving fallback to full scan still works when changed paths are absent or unsafe.

Expected files:
- `tests/index-incremental-dirty.test.ts` or existing index manager test.
- `src/indexer/index-manager.ts`.
- New helper module in a later phase, likely `src/indexer/dirty-file-planner.ts`.

Acceptance:
- Dirty indexing parses only changed/new files plus necessary direct importers/barrel dependents.
- Edge rebuild still avoids source re-parse.

Verification:

```powershell
npm test -- tests/index-incremental-dirty.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

### Task 0.3: Add Serve Error Contract Tests

- [x] Test missing config message.
- [x] Test invalid JSON message.
- [x] Test watcher startup failure message.
- [x] Test `--no-mcp` behavior. Recommended behavior: keep the option for compatibility, but fail clearly with `UNSUPPORTED_TRANSPORT` until an HTTP transport exists.
- [x] If `src/mcp/server.ts` has exported lifecycle APIs, test they do not call `process.exit()` when imported programmatically.

Expected files:
- `tests/cli-serve.test.ts` or nearest CLI command tests.
- `src/cli/commands/serve.ts`.
- `src/mcp/server.ts` only if direct process-exit coupling exists there.

Acceptance:
- Bad config, missing config, unsupported transport, and watch failures are distinguishable in both human output and JSON/scriptable paths where applicable.

Verification:

```powershell
npm test -- tests/cli-serve.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

### Task 0.4: Add Secret Resolution Contract Tests

- [x] Add tests for embedding API key resolution precedence.
- [x] Add tests for LLM API key resolution precedence.
- [x] Confirm plaintext config `apiKey` remains a compatibility fallback but emits a warning in doctor/config diagnostics.

Recommended precedence:
1. `CODE_MEMORY_EMBEDDING_API_KEY` / `CODE_MEMORY_LLM_API_KEY`.
2. Provider-specific environment variable, for example `OPENAI_API_KEY`.
3. Existing `.code-memory/config.json` `apiKey` field.

Expected files:
- `tests/provider-secrets.test.ts`.
- New `src/shared/provider-config.ts` or `src/shared/secrets.ts`.
- Provider consumers in embedding, vector search, summary generation, and doctor.

Acceptance:
- Environment variables override config secrets.
- README no longer recommends writing API keys into `.code-memory/config.json` as the primary path.

### Task 0.5: Measure Current Coverage Before Adding Thresholds

- [x] Run coverage once to capture current baseline.
- [x] Pick conservative thresholds that pass the current baseline after planned tests.
- [x] Avoid setting thresholds so high that unrelated future small changes are blocked by historical uncovered code.

Verification:

```powershell
npm test -- --coverage --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

---

## Phase 1: Watch Ignore Rules And Changed Path Collection

**Purpose:** Fix the most direct operational bug: `serve --watch` should respect project ignore configuration and pass the actual changed path set to incremental indexing.

### Task 1.1: Reuse Existing Ignore Rule System In Watcher

- [x] Inspect `src/scanner/ignore-rules.ts`.
- [x] Use `createIgnoreRule(rootPath, config.ignore || [])` or the existing project scanner helper instead of duplicating ignore logic.
- [x] Convert chokidar absolute paths into normalized project-relative paths before checking ignore rules.
- [x] Always ignore `.git`, `.code-memory`, `node_modules`, build output, and configured ignore patterns.
- [x] Keep cross-platform Windows path normalization explicit.

Implementation notes:
- The watcher `ignored` option should be a function, not only a static array.
- The function must handle both files and directories.
- Do not ignore the project root itself.

Acceptance:
- A file matching config ignore never schedules indexing.
- A file matching `.gitignore` never schedules indexing.
- A normal source file still schedules indexing.

### Task 1.2: Add Pending Path Buffer

- [x] Add `pendingPaths: Set<string>` to `WatchService`.
- [x] On `add`, `change`, and `unlink`, normalize and add the path to the set.
- [x] Preserve debounce behavior.
- [x] On sync, snapshot and clear the set before calling the index manager.
- [x] If indexing fails, preserve enough diagnostic state to report the failed paths.

Expected behavior:

```ts
await manager.incrementalIndex({
  changedPaths: Array.from(pendingPaths),
  forceAll: false,
  fallbackToScan: true,
});
```

Acceptance:
- Multiple rapid file changes are coalesced into one incremental run.
- The index manager receives the exact changed path set.
- The watcher does not silently drop unlink events.

### Task 1.3: Watch Diagnostics

- [x] Record the last watch trigger reason.
- [x] Record changed path count.
- [x] Record last watch sync error.
- [x] Surface this later through `status --staleness --json` and MCP diagnostics.

Acceptance:
- When watch indexing fails, the MCP server can continue serving and diagnostics show `failed` or `stale`, not `fresh`.

Verification for Phase 1:

```powershell
npm test -- tests/watch-service.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
npm run build
```

---

## Phase 2: Path-Aware Incremental Indexing

**Purpose:** Stop watch-triggered incremental indexing from scanning the whole project for every small edit.

### Task 2.1: Preserve Backward Compatibility For `incrementalIndex`

- [x] Keep the current boolean call shape working.
- [x] Add an options object overload.

Recommended type:

```ts
export interface IncrementalIndexOptions {
  forceAll?: boolean;
  changedPaths?: string[];
  fallbackToScan?: boolean;
}
```

Compatibility rules:
- `incrementalIndex(true)` remains full/forced behavior.
- `incrementalIndex(false)` remains existing scan-based incremental behavior.
- `incrementalIndex({ changedPaths })` uses the new path-aware planner.

### Task 2.2: Create Dirty File Planner

- [x] Add `src/indexer/dirty-file-planner.ts`.
- [x] Normalize absolute and relative changed paths.
- [x] Filter ignored paths using the same ignore system as project scanning.
- [x] Detect unsupported/unindexable files.
- [x] Distinguish `changed`, `new`, and `deleted`.
- [x] Resolve current DB file records for deleted paths.
- [x] Build minimal `DiscoveredFile` records for existing changed/new paths without scanning the entire repo.
- [x] Mark unsafe inputs for fallback, for example too many paths, directory paths, or unknown mass rename patterns.

Recommended output:

```ts
export interface DirtyFilePlan {
  mode: "path-aware" | "fallback-scan" | "noop";
  changedFiles: DiscoveredFile[];
  deletedFileIds: string[];
  deletedPaths: string[];
  ignoredPaths: string[];
  unsupportedPaths: string[];
  fallbackReason?: string;
}
```

Acceptance:
- A single changed `.ts` file produces one changed file.
- A deleted indexed file produces one deleted file id without trying to parse it.
- Ignored and unsupported paths are reported but do not trigger broad work.

### Task 2.3: Integrate Dirty Planner Into Index Manager

- [x] Use the dirty planner when `changedPaths` is provided.
- [x] Avoid `scanProject` for safe path-aware runs.
- [x] Continue using existing import/barrel dirty expansion logic.
- [x] Keep graph rebuild dirty mode scoped to affected files and symbols.
- [x] Keep vector indexing batch-aware; do not accumulate all parse results.
- [x] Update metadata with `dirtyFiles`, `lastIndexDurationMs`, and incremental mode.

Acceptance:
- Changing one source file parses at most the changed file plus direct importers/barrel dependents.
- Deleting one indexed file clears DB and vector references without source reads.
- If changed paths are empty or unsafe, fallback behavior is explicit.

### Task 2.4: Validate Memory Boundaries

- [x] Ensure `parseFilesWithWorkersBatched` remains the only large-project parse path.
- [x] Keep `parseFilesWithWorkers()` guarded for small tests only.
- [x] Add or keep guard: more than `parseBatchSize` or 500 files throws with a message recommending the batched API.
- [x] Confirm worker threads remain stateless and never touch SQLite or LanceDB.

Acceptance:
- 2000-file benchmark does not accumulate full parse results in memory.
- Worker output is written and released batch by batch.

Verification for Phase 2:

```powershell
npm test -- tests/index-incremental-dirty.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
npm run benchmark:index
npm run build
```

---

## Phase 3: Serve Command Error Classification And Lifecycle

**Purpose:** Make `serve` reliable for users and scripts. The current broad catch path can mislabel invalid JSON, watcher failures, and other runtime errors as missing config.

### Task 3.1: Split Config Loading From Server Startup

- [x] Extract config loading and validation into a small helper.
- [x] Return typed errors or throw typed exceptions:
  - `CONFIG_MISSING`
  - `CONFIG_INVALID_JSON`
  - `CONFIG_INVALID_SCHEMA`
  - `WATCH_START_FAILED`
  - `MCP_START_FAILED`
  - `UNSUPPORTED_TRANSPORT`
- [x] Do not let watcher startup errors fall into the missing-config branch.

Acceptance:
- Missing `.code-memory/config.json` gives a clear init recommendation.
- Invalid JSON reports invalid JSON.
- Watcher failures report watch failure.

### Task 3.2: Resolve The Dead `--mcp` Flag

- [x] Decide one of two safe options:
  - Keep `--mcp` default true and make `--no-mcp` fail clearly with `UNSUPPORTED_TRANSPORT`.
  - Remove the public flag if tests and CLI help show it was never functional.
- [x] Prefer keeping the option with a clear unsupported message to avoid surprising existing scripts.
- [x] Update README/CLI help so it no longer implies an alternate transport exists.

Acceptance:
- `code-memory serve --no-mcp` does not silently start the same MCP server.
- The user gets a clear message.

### Task 3.3: Decouple Programmatic Server Lifecycle From `process.exit`

- [x] Inspect `src/mcp/server.ts`.
- [x] If exported startup APIs call `process.exit()` directly, add an option such as `exitOnSignal?: boolean`.
- [x] Keep CLI-owned process exit behavior in CLI entrypoints only.
- [x] Programmatic tests should be able to start/stop without terminating the test runner.

Acceptance:
- CLI behavior remains user-friendly.
- Library/exported behavior is testable and does not kill parent processes.

Verification for Phase 3:

```powershell
npm test -- tests/cli-serve.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
npm run build
```

---

## Phase 4: Secret Handling And Provider Configuration

**Purpose:** Keep local-first privacy while avoiding plaintext credential recommendations.

### Task 4.1: Add Provider Config Resolver

- [x] Add `src/shared/provider-config.ts` or `src/shared/secrets.ts`.
- [x] Centralize embedding provider and LLM provider config resolution.
- [x] Preserve compatibility with existing config fields.
- [x] Prefer environment variables over config file secrets.

Embedding resolution:
1. `CODE_MEMORY_EMBEDDING_API_KEY`
2. Provider-specific environment key, for example `OPENAI_API_KEY`
3. `config.embedding.apiKey`

LLM resolution:
1. `CODE_MEMORY_LLM_API_KEY`
2. Provider-specific environment key, for example `OPENAI_API_KEY`
3. `config.llm.apiKey`

Base URL resolution:
1. `CODE_MEMORY_EMBEDDING_BASE_URL` / `CODE_MEMORY_LLM_BASE_URL`
2. Provider-specific base URL env variable if supported.
3. Config `baseUrl`.

### Task 4.2: Wire Resolver Into Providers

- [x] Update embedding generator.
- [x] Update summary generator.
- [x] Update vector search provider factory if it reads config directly.
- [x] Update doctor checks.
- [x] Ensure repo-aware vector provider changes still use the target repo config.

Acceptance:
- Routed repo vector search uses that repo's provider config.
- Default repo provider config is not polluted by a routed repo query.

### Task 4.3: Update Doctor And README

- [x] Doctor warns if an API key is present in plaintext config.
- [x] Doctor reports whether required provider secrets are available through env or config.
- [x] README Quick Start uses environment variables for provider keys.
- [x] README marks config `apiKey` as compatibility fallback, not recommended default.

Verification for Phase 4:

```powershell
npm test -- tests/provider-secrets.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
npm run build
```

---

## Phase 5: Quality Gates And CI Hardening

**Purpose:** Convert test coverage and operational smoke checks from reports into release blockers.

### Task 5.1: Add Conservative Coverage Thresholds

- [x] Measure current coverage after phases 0-4.
- [x] Add thresholds in `vitest.config.ts`.
- [x] Start conservative, for example:
  - lines: current baseline minus small buffer.
  - statements: current baseline minus small buffer.
  - functions: current baseline minus small buffer.
  - branches: lower than line threshold if current branch coverage is weak.
- [x] Add or confirm a script such as `npm run test:coverage`.

Acceptance:
- Coverage check passes locally.
- Removing meaningful tests causes CI to fail.

### Task 5.2: Update CI Without Overloading The Matrix

- [x] Add coverage check to one representative job first, preferably Ubuntu + Node 22.
- [x] Keep Windows smoke for watch/sync path normalization.
- [x] Keep existing pack, smoke, audit, and benchmark jobs.
- [x] Avoid making every matrix axis run heavy benchmark if CI time is already high.

Acceptance:
- CI has one clear quality gate for coverage.
- Cross-platform path-sensitive behavior is still tested.

### Task 5.3: Update Operational Docs

- [x] README documents:
  - `serve --watch` behavior.
  - watch ignore behavior.
  - path-aware incremental indexing.
  - staleness states.
  - environment variable secrets.
  - language maturity matrix.
- [x] Add troubleshooting section:
  - invalid config JSON.
  - missing config.
  - watch failed.
  - vector drift.
  - stale index.

Acceptance:
- README no longer overpromises semantic/vector features.
- New users can understand watch freshness and provider secret setup.

Verification for Phase 5:

```powershell
npm run lint
npm run build
npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism
npm run pack:check
npm run test:smoke
npm run audit:official
npm run benchmark:index
```

---

## Phase 6: Hot-Path Modular Refactor

**Purpose:** Reduce maintenance risk in large files without changing behavior.

Do this only after phases 1-5 are green. Refactor behind existing public facades and keep tests unchanged.

### Task 6.1: Split Index Manager Responsibilities

- [x] Keep `IndexManager` as the public facade.
- [x] Move run lifecycle state to `src/indexer/index-run-lifecycle.ts`.
- [x] Move dirty path planning to `src/indexer/dirty-file-planner.ts`.
- [x] Move parse batch coordination to `src/indexer/parse-coordinator.ts`.
- [x] Move DB write batches to `src/indexer/persistence-writer.ts`.
- [x] Move graph rebuild orchestration to `src/indexer/graph-rebuild-coordinator.ts`.

Acceptance:
- Public imports do not break.
- `IndexManager` becomes smaller and easier to review.
- Full and incremental index tests pass unchanged.

### Task 6.2: Split Search Hot Paths

- [x] Move RRF logic to `src/search/rrf-fusion.ts`.
- [x] Move result enrichment to `src/search/result-enricher.ts`.
- [x] Move ledger rerank logic to `src/search/ledger-reranker.ts`.
- [x] Keep `HybridSearchEngine` as the orchestrator.

Acceptance:
- Score breakdown remains identical.
- Search mode contract remains identical:
  - `keyword`: FTS5 only.
  - `vector`: vector only, with clear error when unavailable.
  - `graph`: graph expansion only from seeds, with clear no-seed message.
  - `hybrid`: keyword + optional vector + graph.

### Task 6.3: Split Context Packer Hot Paths

- [x] Move token budget handling to `src/search/context-budget.ts`.
- [x] Move evidence assembly to `src/search/evidence-assembler.ts`.
- [x] Move ledger duplicate filtering to `src/search/context-ledger-filter.ts`.
- [x] Keep `ContextPacker` as the public facade.

Acceptance:
- `get_context_pack` fields do not change.
- `avoidRepeated` and fill-after-omit behavior stays covered by tests.

Verification for Phase 6:

```powershell
npm run lint
npm run build
npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

---

## Phase 7: Freshness UX, Language Maturity, And Future Platform Work

**Purpose:** Convert technical correctness into an agent-facing freshness experience and prevent language support overclaiming.

### Task 7.1: Freshness State Model

- [x] Persist:
  - `watch_last_changed_paths`
  - `watch_last_trigger_reason`
  - `watch_last_sync_duration_ms`
  - `watch_pending_count`
  - `last_watch_error`
- [x] Standardize states:
  - `fresh`
  - `stale`
  - `missing`
  - `rebuilding`
  - `failed`
- [x] Add `recommendedAction` to status/MCP diagnostics.

Acceptance:
- MCP tools can warn agents when context is stale or rebuilding.
- `serve --watch` indexing failures do not masquerade as fresh context.

### Task 7.2: Language Contract Alignment

- [x] Compare shared `Language` type, grammar availability, parser support, README maturity matrix, and doctor output.
- [x] Mark Python/Go as beta/partial if resolver precision is incomplete.
- [x] Do not advertise unsupported languages as fully indexed.
- [x] Add a fixture before claiming a new language maturity level.

Acceptance:
- README, doctor, and actual parser behavior agree.

### Task 7.3: Long-Term Research Backlog

Keep these as backlog until watch correctness and operational hardening are stable:

- [ ] GraphRAG/community detection for task-level repo maps.
- [ ] LSP-backed definition/reference validation.
- [ ] Framework-specific route mapping beyond current Next/FastAPI support.
- [ ] Public benchmark with task success, key-file recall, evidence coverage, repeated context ratio, token cost, tool calls, stale failure rate, and hallucinated symbol rate.
- [ ] Context Inspector UI for query, context pack, why included, dropped repeated context, graph paths, related tests, freshness, and MCP call JSON.

---

## Cross-Phase Risks And Mitigations

### Risk: Path-Aware Incremental Misses Files

Mitigation:
- Fallback to full scan when changed paths are empty, too broad, directories, or unsafe.
- Keep a clear `fallbackReason`.
- Add benchmark and watch smoke tests on Windows and Ubuntu.

### Risk: Watch Path Normalization Breaks On Windows

Mitigation:
- Normalize paths in one helper.
- Test absolute Windows-like paths and POSIX-like paths.
- Use project-relative paths internally.

### Risk: Secret Resolver Breaks Existing Config

Mitigation:
- Keep config `apiKey` fallback.
- Add doctor warning, not hard failure.
- Document env-first recommendation.

### Risk: Coverage Gate Blocks CI Due To Historical Gaps

Mitigation:
- Measure first.
- Set conservative thresholds.
- Increase thresholds later after targeted tests.

### Risk: Modular Refactor Introduces Behavior Drift

Mitigation:
- Refactor only after behavior tests are green.
- Keep facade APIs stable.
- Compare search/index/status snapshots before and after refactor.

---

## Final Verification Checklist

Run this after all phases that modify behavior:

```powershell
npm run lint
npm run build
npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism
npm run pack:check
npm run test:smoke
npm run audit:official
npm run benchmark:index
npx gitnexus detect-changes --repo code-memory --scope all
codegraph sync .
codegraph status .
```

Expected outcome:
- Watch ignores config and `.gitignore`.
- Watch sends changed paths to path-aware incremental index.
- Single-file watch updates do not full-scan the repository unless fallback is explicit.
- Serve errors are accurately classified.
- Provider secrets prefer environment variables.
- Coverage is enforced.
- Hot-path files have a refactor route that does not change CLI/MCP contracts.
