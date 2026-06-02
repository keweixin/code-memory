# Agent Context Governor Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Code Memory from a code search/index MCP server into a reliable Agent Context Governor: intent-aware retrieval, ledger-aware reranking, evidence-first context packs, strict memory freshness, consistent tool contracts, and benchmarked token-efficiency gains.

**Architecture:** Keep the current native SQLite + FTS5 + LanceDB + Tree-sitter architecture. Do not reintroduce `files.calls_json`; calls remain normalized in `call_refs`. Build the governor as a pipeline: task intent -> candidate generation -> ledger-aware rerank -> budget-aware packing -> evidence diagnostics -> feedback/ledger/memory updates.

**Tech Stack:** TypeScript, Node >=20, better-sqlite3, SQLite FTS5/WAL, LanceDB, web-tree-sitter, MCP SDK, Vitest, GitNexus/CodeGraph for impact analysis.

---

## Current Baseline

Current HEAD already has important foundations:

- Native SQLite via `better-sqlite3`, WAL/FTS5, schema v3.
- Worker parse pool with `auto` capped at 8 workers.
- Normalized parse metadata tables: `file_imports`, `file_exports`, `call_refs`, `scope_bindings`, `type_relations`, `route_endpoints`, `route_references`.
- Graph rebuild uses persisted metadata and no longer reparses source files.
- Vector search can use LanceDB when an embedding provider is configured.
- Context ledger exists, but `get_context_pack` still applies repeated-context omission after candidate search/packing.
- MCP tool surface is useful but not yet fully normalized around a single response envelope and score/evidence diagnostics.

## Non-Goals

- Do not replace SQLite with a graph database in this plan.
- Do not expand all languages at once. TS/JS/TSX are the correctness target; Python/Go improvements are later milestones.
- Do not default to full-file context. L5 full-file output remains explicit or rare.
- Do not let memory override live index evidence.
- Do not add `files.calls_json`; it duplicates `call_refs` and weakens queryability.

## Global Requirements

Every phase must preserve these invariants:

- `npm run build` passes.
- `npm test` passes.
- `npm pack --dry-run` passes.
- `npm run benchmark:index -- --files 2000 --workers auto --embedding none` does not OOM.
- `npx gitnexus analyze` and `gitnexus detect_changes` are run before any commit.
- Public CLI command names and MCP tool names remain backward compatible unless a phase explicitly introduces an additive tool.

---

## Phase 0: Contract Freeze And Audit Harness

**Purpose:** Create the shared types, invariant checks, and contract-test helpers that later phases depend on.

### Task 0.1: Define Shared Evidence, Score, And Tool Envelope Types

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/storage/invariants.ts`
- Test: `tests/tool-response-contract.test.ts`

**Acceptance criteria:**
- [ ] Add `EvidenceItem`, `ScoreBreakdown`, `ToolDiagnostics`, `ToolSuccessEnvelope<T>`, `ToolErrorEnvelope`.
- [ ] Keep existing MCP outputs compatible by allowing tools to expose the envelope through a `diagnostics` field first, before full migration.
- [ ] Error codes include `INDEX_MISSING`, `VECTOR_UNAVAILABLE`, `QUERY_TOO_BROAD`, `NO_RESULTS`, `STALE_INDEX`, `SCHEMA_MISMATCH`.

**Suggested type shape:**

```ts
export interface EvidenceItem {
  id: string;
  kind: 'ast_node' | 'import_clause' | 'call_expr' | 'route_literal' | 'test_name' | 'config' | 'memory' | 'ledger';
  filePath?: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  contentHash?: string;
  preview?: string;
  confidence: number;
}

export interface ScoreBreakdown {
  keyword?: number;
  vector?: number;
  graph?: number;
  route?: number;
  test?: number;
  memory?: number;
  freshness?: number;
  evidence?: number;
  ledgerPenalty?: number;
}

export interface ToolDiagnostics {
  schemaVersion: number;
  indexCommit?: string;
  vectorUsed: boolean;
  graphUsed: boolean;
  repeatedContextOmitted: number;
  staleIndex?: boolean;
}
```

**Verification:**
- [ ] Run: `npx vitest run tests/tool-response-contract.test.ts --testTimeout=15000`
- [ ] Run: `npm run build`

### Task 0.2: Add Hard Invariant Tests For Current Index Data

**Files:**
- Modify: `src/storage/invariants.ts`
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/doctor-invariants.test.ts`

**Acceptance criteria:**
- [ ] Assert `symbol.start_line <= symbol.end_line`.
- [ ] Assert `chunk.start_byte < chunk.end_byte`.
- [ ] Assert every edge endpoint exists unless represented as unresolved metadata rather than an edge.
- [ ] Assert every chunk has a valid `content_hash`.
- [ ] Assert every graph edge has at least one evidence row when the edge type is evidence-backed.

**Verification:**
- [ ] Run: `npx vitest run tests/doctor-invariants.test.ts tests/graph-evidence.test.ts --testTimeout=15000`

### Task 0.3: Add Tool Contract Test Matrix

**Files:**
- Create: `tests/mcp-tool-contracts.test.ts`
- Modify: `src/mcp/tool-registry.ts`

**Acceptance criteria:**
- [ ] Every registered MCP tool has at least one contract test.
- [ ] Every tool returns a clear error when no index exists.
- [ ] Every tool that returns locations includes line and column when the underlying data has it.
- [ ] No response includes literal `undefined`.

**Verification:**
- [ ] Run: `npx vitest run tests/mcp-tool-contracts.test.ts --testTimeout=15000`

---

## Phase 1: Intent Router And Edge Profiles

**Purpose:** Stop using one generic graph/search behavior for all tasks. Route by task intent and restrict graph expansion to relevant edge types.

### Task 1.1: Add Deterministic Intent Classifier

**Files:**
- Create: `src/search/intent-router.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/intent-router.test.ts`

**Acceptance criteria:**
- [ ] Classify at least `debug`, `refactor`, `add_test`, `explain`, `route`, `security`, `general`.
- [ ] Use deterministic keyword rules only; do not call an LLM.
- [ ] Return matched hints for diagnostics.

**Verification:**
- [ ] Run: `npx vitest run tests/intent-router.test.ts --testTimeout=15000`

### Task 1.2: Add Intent-Aware Graph Edge Profiles

**Files:**
- Modify: `src/search/graph-search.ts`
- Modify: `src/graph/impact-analyzer.ts`
- Modify: `src/mcp/tools/impact-analysis.ts`
- Test: `tests/graph-intent-profile.test.ts`

**Acceptance criteria:**
- [ ] `debug` uses `CALLS`, `REFERENCES`, `IMPORTS`, `CONFIGURES`, `ROUTE_REFERENCES`.
- [ ] `refactor` defaults to incoming `REFERENCES`, `CALLS`, `IMPORTS`, `TESTS`.
- [ ] `route` includes `ROUTE_ENDPOINT`, `ROUTE_REFERENCES`, `CALLS`.
- [ ] Graph expansion diagnostics list which profile was used.

**Verification:**
- [ ] Run: `npx vitest run tests/graph-intent-profile.test.ts tests/impact-cte-language-relations.test.ts --testTimeout=15000`

---

## Phase 2: Ledger-Aware Retrieval Before Packing

**Purpose:** Move context ledger from "delete after pack" to "rerank before pack", then fill the budget with fresh evidence.

### Task 2.1: Expose Ledger History As Candidate Penalty Data

**Files:**
- Modify: `src/memory/context-ledger.ts`
- Modify: `src/storage/memory-repository.ts`
- Test: `tests/context-ledger.test.ts`

**Acceptance criteria:**
- [ ] Add a method that returns repeated file/symbol/chunk ids for a `sessionId`.
- [ ] Include useful/irrelevant feedback in the returned penalty data.
- [ ] Clear repeated penalties when a file hash has changed since the ledger entry.

**Verification:**
- [ ] Run: `npx vitest run tests/context-ledger.test.ts --testTimeout=15000`

### Task 2.2: Add Ledger Penalty To Hybrid Search

**Files:**
- Modify: `src/search/hybrid-search.ts`
- Modify: `src/mcp/tools/search-code.ts`
- Modify: `src/cli/commands/query.ts`
- Test: `tests/hybrid-ledger-rerank.test.ts`

**Acceptance criteria:**
- [ ] `SearchOptions` accepts `sessionId`, `avoidRepeated`, `intent`.
- [ ] Same chunk returned in the session gets `ledgerPenalty >= 0.60`.
- [ ] Same symbol gets `ledgerPenalty >= 0.35`.
- [ ] Same file but different chunk gets `ledgerPenalty >= 0.15`.
- [ ] Results include `ScoreBreakdown.ledgerPenalty`.

**Verification:**
- [ ] Run: `npx vitest run tests/hybrid-ledger-rerank.test.ts tests/cli-query.test.ts tests/mcp-vector-search.test.ts --testTimeout=15000`

### Task 2.3: Make Context Pack Fill After Omit

**Files:**
- Modify: `src/search/context-packer.ts`
- Modify: `src/mcp/tools/get-context-pack.ts`
- Test: `tests/mcp-context-pack-ledger.test.ts`

**Acceptance criteria:**
- [ ] `get_context_pack` defaults to ledger-aware reranking when `sessionId` is provided.
- [ ] `fillAfterOmit` fills the budget with new candidates after repeated snippets are removed.
- [ ] Third repeated query returns `missingInfo` explaining no new context if exhausted.
- [ ] Repeated snippet ratio is asserted below 10% in the fixture test.

**Verification:**
- [ ] Run: `npx vitest run tests/mcp-context-pack-ledger.test.ts tests/context-pack-quality.test.ts --testTimeout=15000`

---

## Phase 3: Evidence-First Context Pack

**Purpose:** Make context packs explain exactly why each snippet, route, test, graph path, and memory was included.

### Task 3.1: Add Structured Pack Sections

**Files:**
- Modify: `src/search/context-packer.ts`
- Modify: `src/mcp/tools/get-context-pack.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/context-pack-structure.test.ts`

**Acceptance criteria:**
- [ ] Pack includes `query`, `intent`, `budget`, `evidence`, `files`, `symbols`, `snippets`, `graphPaths`, `tests`, `routes`, `memories`, `missingInfo`, `repeated`.
- [ ] Existing text output remains readable.
- [ ] Each snippet has `chunkId`, `filePath`, line range, `contentHash`, `reason`, `confidence`, `alreadyReturned`.

**Verification:**
- [ ] Run: `npx vitest run tests/context-pack-structure.test.ts tests/mcp-context-pack-ledger.test.ts --testTimeout=15000`

### Task 3.2: Enforce L3/L4-First Packing Rules

**Files:**
- Modify: `src/search/context-packer.ts`
- Test: `tests/context-pack-quality.test.ts`

**Acceptance criteria:**
- [ ] Default pack does not include full files unless the file is under 120 lines or explicitly requested.
- [ ] At least 80% of used token budget is L3/L4 in fixture tests.
- [ ] Every pack includes `missingInfo`, even when empty.

**Verification:**
- [ ] Run: `npx vitest run tests/context-pack-quality.test.ts --testTimeout=15000`

---

## Phase 4: Explainable Hybrid Search

**Purpose:** Make every search result explain source contributions instead of returning a single opaque score.

### Task 4.1: Add Source-Specific Candidate Types

**Files:**
- Modify: `src/search/hybrid-search.ts`
- Modify: `src/search/fts-search.ts`
- Modify: `src/search/graph-search.ts`
- Modify: `src/search/vector-search.ts`
- Test: `tests/hybrid-score-breakdown.test.ts`

**Acceptance criteria:**
- [ ] `SearchResult` includes `scoreBreakdown`.
- [ ] `sources` distinguishes `keyword_symbol`, `keyword_file`, `vector_chunk`, `graph_neighbor`, `route_match`, `test_match`, `memory_match`, `path_match`.
- [ ] Hybrid diagnostics prove whether vector participated.

**Verification:**
- [ ] Run: `npx vitest run tests/hybrid-score-breakdown.test.ts tests/vector-search.test.ts tests/hybrid-search-enrichment.test.ts --testTimeout=20000`

### Task 4.2: Add Graph Path Explanation To Graph Results

**Files:**
- Modify: `src/search/graph-search.ts`
- Modify: `src/graph/graph-engine.ts`
- Test: `tests/graph-search-paths.test.ts`

**Acceptance criteria:**
- [ ] Graph-expanded results include a short path from seed to result.
- [ ] Result path includes edge type and confidence.
- [ ] Graph mode with no seed returns a clear `NO_RESULTS` diagnostic.

**Verification:**
- [ ] Run: `npx vitest run tests/graph-search-paths.test.ts tests/indexing-core.test.ts --testTimeout=15000`

---

## Phase 5: Memory Relevance, Freshness, And Invalidation

**Purpose:** Keep memory strict and evidence-backed so it improves context instead of polluting it.

### Task 5.1: Add Memory Scope And Freshness Scoring

**Files:**
- Modify: `src/memory/memory-manager.ts`
- Modify: `src/storage/memory-repository.ts`
- Modify: `src/mcp/tools/remember-project-fact.ts`
- Test: `tests/memory-relevance.test.ts`

**Acceptance criteria:**
- [ ] Memory has type, scope, evidence, confidence, freshness, invalidation refs, `lastVerifiedAt`.
- [ ] Memory retrieval requires query relevance, scope relevance, freshness, confidence, and evidence.
- [ ] Stale memories are either omitted or explicitly marked stale.

**Verification:**
- [ ] Run: `npx vitest run tests/memory-relevance.test.ts tests/context-ledger.test.ts --testTimeout=15000`

### Task 5.2: Add Memory Verification MCP Tools

**Files:**
- Create: `src/mcp/tools/list-relevant-memories.ts`
- Create: `src/mcp/tools/verify-memory.ts`
- Create: `src/mcp/tools/forget-stale-memory.ts`
- Modify: `src/mcp/tool-registry.ts`
- Test: `tests/mcp-memory-tools.test.ts`

**Acceptance criteria:**
- [ ] `list_relevant_memories` explains why each memory is relevant.
- [ ] `verify_memory` refreshes freshness only if evidence still exists.
- [ ] `forget_stale_memory` deletes or marks stale records based on explicit input.

**Verification:**
- [ ] Run: `npx vitest run tests/mcp-memory-tools.test.ts --testTimeout=15000`

---

## Phase 6: Plan Context Tool

**Purpose:** Give agents a cheap planning step before retrieving code snippets.

### Task 6.1: Implement `plan_context`

**Files:**
- Create: `src/mcp/tools/plan-context.ts`
- Modify: `src/mcp/tool-registry.ts`
- Test: `tests/mcp-plan-context.test.ts`
- Modify docs: `README.md`

**Acceptance criteria:**
- [ ] Tool accepts `task`, `sessionId`, `intent?`, `tokenBudget?`.
- [ ] Tool returns intent, edge profile, expected evidence types, repeated context it will avoid, estimated tokens.
- [ ] Tool does not return source snippets.
- [ ] README recommends `plan_context -> get_context_pack -> precision tools -> mark_context_used`.

**Verification:**
- [ ] Run: `npx vitest run tests/mcp-plan-context.test.ts tests/mcp-context-ledger-tools.test.ts --testTimeout=15000`

---

## Phase 7: Index Lifecycle And Deep Doctor

**Purpose:** Make operational health obvious: schema, stale index, vector consistency, graph evidence, memory freshness.

### Task 7.1: Add Index State Machine

**Files:**
- Modify: `src/storage/database.ts`
- Modify: `src/cli/commands/status.ts`
- Modify: `src/mcp/tools/get-project-card.ts`
- Test: `tests/index-state.test.ts`

**Acceptance criteria:**
- [ ] Status states include `not_initialized`, `initialized_no_index`, `indexing`, `ready`, `ready_stale`, `ready_partial`, `schema_mismatch`, `corrupt`.
- [ ] `status --json` exposes state, counts, stale files, unresolved imports/calls, vector count.
- [ ] MCP project card uses the same state.

**Verification:**
- [ ] Run: `npx vitest run tests/index-state.test.ts tests/cli-index.test.ts tests/mcp-project-card.test.ts --testTimeout=15000`

### Task 7.2: Add `doctor --deep`

**Files:**
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/storage/invariants.ts`
- Modify: `src/search/vector-search.ts`
- Test: `tests/doctor-deep.test.ts`

**Acceptance criteria:**
- [ ] Deep doctor checks SQLite readability, WAL, FTS5, grammars, TSX grammar, worker availability, schema version, vector provider, vector/chunk consistency, orphan records, evidence coverage, unresolved ratios, stale memory ratio, ledger writability.
- [ ] `doctor --json --deep` returns machine-readable checks.
- [ ] `doctor --deep` gives actionable suggested fixes.

**Verification:**
- [ ] Run: `npx vitest run tests/doctor-deep.test.ts tests/cli-doctor.test.ts --testTimeout=15000`

---

## Phase 8: Golden Fixtures For TS/JS/TSX Correctness

**Purpose:** Turn parser correctness into fixture diffs instead of informal assertions.

### Task 8.1: Add Fixture Manifest And Expected Output Format

**Files:**
- Create: `tests/fixtures/golden/README.md`
- Create: `tests/golden-fixtures.test.ts`
- Create: `tests/helpers/golden.ts`

**Acceptance criteria:**
- [ ] Each fixture includes `expected.json` with files, symbols, imports, exports, calls, routes, tests.
- [ ] Golden test output prints a compact diff when actual data differs.
- [ ] Golden runner supports worker and non-worker indexing.

**Verification:**
- [ ] Run: `npx vitest run tests/golden-fixtures.test.ts --testTimeout=30000`

### Task 8.2: Add Initial High-Value Golden Fixtures

**Files:**
- Create: `tests/fixtures/golden/ts-reexport`
- Create: `tests/fixtures/golden/tsx-react-app`
- Create: `tests/fixtures/golden/next-app-router`
- Create: `tests/fixtures/golden/express-route`
- Create: `tests/fixtures/golden/test-colocation`

**Acceptance criteria:**
- [ ] Re-export aliases and namespaces resolve to expected symbols.
- [ ] TSX components produce symbols and chunks.
- [ ] Next route handlers and frontend fetch references create route metadata.
- [ ] Co-located tests produce test graph edges.

**Verification:**
- [ ] Run: `npx vitest run tests/golden-fixtures.test.ts tests/route-mapping.test.ts tests/indexing-core.test.ts --testTimeout=30000`

---

## Phase 9: Benchmark Suite For Context Quality

**Purpose:** Prove Code Memory reduces context waste and improves task localization, not just raw index speed.

### Task 9.1: Add Benchmark Task Format

**Files:**
- Create: `benchmark/tasks/README.md`
- Create: `benchmark/tasks/debug-auth-token/task.json`
- Create: `benchmark/tasks/refactor-user-service/task.json`
- Create: `benchmark/tasks/explain-next-route/task.json`
- Create: `tools/benchmark-context.mjs`
- Test: `tests/context-benchmark.test.ts`

**Acceptance criteria:**
- [ ] Task JSON includes task text, expected files, expected symbols, expected snippets, forbidden waste files, success criteria.
- [ ] Benchmark compares `keyword_only`, `vector_only`, `graph_only`, `hybrid`, `hybrid_ledger`.
- [ ] Output includes context precision, critical file recall, critical symbol recall, repeated context ratio, evidence coverage, token waste ratio.

**Verification:**
- [ ] Run: `node tools/benchmark-context.mjs --task benchmark/tasks/debug-auth-token --mode hybrid_ledger`
- [ ] Run: `npx vitest run tests/context-benchmark.test.ts --testTimeout=30000`

### Task 9.2: Add Regression Thresholds

**Files:**
- Modify: `tools/benchmark-context.mjs`
- Modify: `package.json`
- Test: `tests/context-benchmark.test.ts`

**Acceptance criteria:**
- [ ] Add `npm run benchmark:context`.
- [ ] Thresholds fail if repeated context ratio is above 0.10 or evidence coverage below 0.95 for benchmark fixtures.
- [ ] CI can run a small benchmark task without external embeddings.

**Verification:**
- [ ] Run: `npm run benchmark:context -- --task benchmark/tasks/debug-auth-token --embedding none`

---

## Phase 10: Documentation And Release Readiness

**Purpose:** Make the product position and operational model clear.

### Task 10.1: Reframe README Around Agent Context Governor

**Files:**
- Modify: `README.md`

**Acceptance criteria:**
- [ ] README opens with "Agent Context Governor for Codebases" positioning.
- [ ] Explain recommended agent flow: `plan_context`, `get_context_pack`, precision tools, `mark_context_used`.
- [ ] Clearly state vector prerequisites and fallback behavior.
- [ ] Clearly state TS/JS/TSX as first-class reliable languages and Python/Go as partial graph quality.

**Verification:**
- [ ] Run: `npm run pack:check`

### Task 10.2: Add Architecture Doc

**Files:**
- Create: `docs/architecture/context-governor.md`

**Acceptance criteria:**
- [ ] Document pipeline: intent -> recall -> ledger rerank -> pack -> feedback -> memory invalidation.
- [ ] Document table ownership and which module writes each table.
- [ ] Document why `call_refs` is used instead of `files.calls_json`.

**Verification:**
- [ ] Run: `npm run pack:check`

---

## Execution Order

Implement in this strict order:

1. Phase 0: Contract freeze and audit harness.
2. Phase 1: Intent router and graph profiles.
3. Phase 2: Ledger-aware retrieval before packing.
4. Phase 3: Evidence-first context pack.
5. Phase 4: Explainable hybrid search.
6. Phase 5: Memory relevance and staleness.
7. Phase 6: `plan_context`.
8. Phase 7: Index lifecycle and deep doctor.
9. Phase 8: Golden fixtures.
10. Phase 9: Context benchmark suite.
11. Phase 10: Documentation and release readiness.

Do not start a later phase until the previous phase has tests passing. Keep commits small: one task or one tightly-coupled pair of tasks per commit.

## Verification Gates

After each phase:

```powershell
npm run build
npm test
git diff --check
```

Before merge/push:

```powershell
npm run lint
npm run build
npm test
npm pack --dry-run
npm run audit:official
npm run benchmark:index -- --files 2000 --workers auto --embedding none
npx gitnexus analyze
```

Then run GitNexus change detection through MCP:

```text
gitnexus detect_changes scope=all repo=code-memory
```

## Final 10-Point Acceptance Checklist

- [ ] Parser: TS/JS/TSX golden fixtures pass.
- [ ] Location: every MCP result with source evidence has line/column/hash.
- [ ] Chunks: chunk hashes can be verified against source slices.
- [ ] Graph: edge evidence coverage is above 95%.
- [ ] Search: every result has score breakdown and why.
- [ ] Ledger: repeated context is penalized before packing and fresh context fills the budget.
- [ ] Memory: relevance, freshness, invalidation, and evidence are enforced.
- [ ] MCP: tool contracts are tested and error responses are standardized.
- [ ] Index: full and incremental converge for fixture mutations.
- [ ] Vector: SQLite/LanceDB consistency is diagnosable.
- [ ] Doctor: deep health report gives actionable fixes.
- [ ] Benchmark: hybrid-ledger beats keyword-only by at least 30% token efficiency on benchmark fixtures.

