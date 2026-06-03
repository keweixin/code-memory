# Changelog

## [0.3.7] - 2026-06-04

### Added
- Add a shared `CodeMemoryToolResult` envelope for core MCP project/retrieval tools with machine-readable `status`, `project`, `freshness`, `data`, `nextAction`, and `display`
- Add `benchmark/real-repos.json` with pinned public repo tasks and v1 benchmark threshold targets
- Add contract tests for structured tool results, project management recovery, allowed reads, impact analysis, and real-repo benchmark config

### Changed
- Return structured JSON from `resolve_project`, `bootstrap_project`, `sync_project`, `register_project`, `search_code`, `get_context_pack`, and `impact_analysis`
- Upgrade `get_context_pack` Tool Trust Contract with structured `allowedNextReads` and `discouragedReads`
- Strengthen MCP instructions and docs so agents avoid broad Read/Grep/Glob after a ready context pack
- Keep index diagnostics inside structured `display` instead of prefixing JSON tool results

## [0.3.6] - 2026-06-03

### Fixed
- Add the missing shared/module benchmark fixture files to the context benchmark so task definitions match the indexed project
- Add the auth/user benchmark fixture files to the agent benchmark so all published tasks are measured against real indexed files
- Improve no-embedding natural-language search recall with an FTS5 relaxed query fallback after strict matching
- Measure agent hallucinated symbols against the actual SQLite `symbols` table instead of a broad search approximation

### Changed
- Make benchmark quality gates fail on agent `taskSuccess=false` instead of emitting a warning
- Raise default release/CI quality floors to production targets: context and agent key-file recall >= 0.90 and evidence coverage >= 0.95
- Gate context quality on primary production modes (`hybrid` and `hybrid_ledger`) while still reporting all ablation-mode metrics

## [0.3.5] - 2026-06-03

### Fixed
- Route all database-backed MCP tools through a shared ToolContext input contract (`repo`, `project`, `cwd`, `workspaceRoots`)
- Keep global MCP servers usable from unrelated working directories when tools pass an explicit `project` path
- Document `bootstrap_project`, `sync_project`, and `register_project` as first-class agent workflow tools across README, resources, generated context, and skills
- Ignore and remove local root-level command output captures from the tracked tree

### Added
- Add a benchmark quality gate for index, context, and agent benchmark JSON outputs
- Enforce benchmark quality gates in CI and release workflows instead of warning-only benchmark parsing

## [0.3.4] - 2026-06-03

### Fixed
- Align README first-screen version messaging with the runtime/package version
- Make release workflow idempotent when a GitHub Release already exists for the tag
- Register projects automatically during `setup --project`
- Include `CODE_MEMORY_PROJECT` in generated global `--auto-project` MCP configs as the default project identity
- Add always-available MCP project management tools: `bootstrap_project`, `sync_project`, and `register_project`

## [0.3.3] - 2026-06-03

### Fixed
- Register MCP tools with an explicit optional default database contract for global `--auto-project` mode
- Keep `resolve_project` available when the server starts without a project index
- Route repo-aware tools through lazy database resolution when no startup database exists
- Return bootstrap protocol guidance for missing projects instead of failing global tool calls

## [0.3.2] - 2026-06-03

### Fixed
- Publish under the available scoped npm package name `@keweixin/code-memory`
- Generated `npx` MCP setup, hook, resolver recovery commands, README, and release docs now use `@keweixin/code-memory@latest`
- Keep the CLI binary name as `code-memory` while avoiding the already-owned unscoped npm package name

## [0.3.1] - 2026-06-03

### Fixed
- Global MCP resources can lazy-open project databases and return bootstrap protocol responses when no index exists
- `resolve_project` reports stale indexes with an actionable `sync --project` command
- Context Ledger MCP workflow hints now guide agents through `mark_context_used`, `get_context_delta`, and repeated-context avoidance
- `remember_project_fact` and `invalidate_memory` now route memory writes/deletes to the requested repo database instead of the default DB
- `get_context_pack` Tool Trust Contract now includes exact snippet code, not just file and line metadata
- README, MCP docs, generated project context, skills, and resources now share the same Ledger-aware workflow

## [0.3.0] - 2026-06-02

### Added
- First-run `setup --project <path>` workflow that bootstraps the index, writes MCP config, installs project context files, installs generated Code Memory skills, and runs `doctor`
- `bootstrap --project <path>` command for safe init/index lifecycle recovery
- `analyze --project <path>` command for index plus project AI context without agent MCP config
- `tool` CLI mirror for running MCP tools without an MCP client
- `serve --watch` cold-start bootstrap by default, with `--no-bootstrap` strict mode
- Runtime-aware MCP setup: `--runtime npx | global | local`
- Project onboarding uninstall for generated context blocks, Code Memory skills, and Claude Code hook artifacts
- Doctor checks for setup context, generated skills, and Claude Code hook readiness
- Process Detection: trace execution flows from HTTP routes / `main` / `export default` through the call graph to terminal nodes (throw, process.exit, SQL writes)
- Community Detection: lightweight Louvain modularity algorithm grouping related symbols by call/import/extends graph connectivity
- Adaptive Output Budget: 5-tier dynamic sizing (tiny/small/medium/large/huge) for `get_context_pack`, `plan_context`, and `explain_module` based on indexed node count
- Stale File Banner: warns AI agents when MCP tool responses reference files pending re-indexing (5 tools: `get_context_pack`, `search_code`, `find_definition`, `plan_context`, `explain_module`)
- Wiki CLI: `code-memory wiki` generates `.code-memory/wiki.json` with project summary, communities, processes, routes, and external dependencies
- Multi-Repo Unified View: `get_unified_repo_map` MCP tool aggregates overviews across registered repos with cross-repo dependency suggestions
- Schema v7: `processes`, `process_steps`, `communities`, `community_members` tables

### Changed
- README now includes current release status, exact first-run commands, and measured benchmark baselines
- Release workflow now validates tag/package version consistency and can publish npm when `NPM_TOKEN` is configured
- `get_repo_map` now groups files by community when communities exist
- `get_unified_repo_map` repos filter now uses case-insensitive substring matching
- `watch-service.getPendingFiles().indexing` now reflects per-file indexing state instead of global run state
- `watch-service` supports multiple project roots simultaneously (Map-based state)
- `wiki.json` `project.summary` is now populated from `package.json` description or community keywords
- `wiki.json` process step names now come from the `symbols` table instead of fragile label parsing
- `process-tracer` BFS uses head pointer (O(n+m) instead of O(n²)) and symbol cache
- `countIndexedNodes` uses `db.get` instead of `db.exec`
- `findEntryPoints` uses `IN (...)` instead of `OR` + `LIKE`

### Fixed
- `plan_context` and `explain_module` now include stale file banners (were missing)
- Stale banner path extraction now supports Windows absolute paths and git diff style paths
- Stale banner time formatting is now injectable for deterministic testing
- Community detector `?? 0` dead code on TypedArray elements cleaned up
- Process tracer `__test` dead code export removed
- Wiki command now validates path arguments to prevent directory traversal

## 0.2.0

- Reposition Code Memory as a Context Ledger and evidence-backed code graph for AI coding agents.
- Add productized setup/uninstall, watch/sync, staleness, and registry foundations.
- Expand Context Ledger metadata for novelty, repeated-context penalties, evidence fingerprints, task IDs, branch, and commit.
- Keep the project local-first and MCP-first, with optional vector retrieval only when an embedding provider is configured.

## 0.1.x

- Initial CLI, MCP server, native SQLite/FTS5 index, TypeScript/JavaScript-first graph indexing, route mapping, context packs, and Context Ledger tools.
