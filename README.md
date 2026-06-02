# Code Memory

Context Ledger for AI coding agents.

Code Memory is a local-first Context Ledger and evidence-backed code graph. It helps agents retrieve the right code once, avoid repeated files and snippets across a coding session, and explain why every context item was included.

```bash
npx code-memory@latest init -i
npx code-memory@latest setup --agent codex --dry-run
code-memory serve --watch
```

## Why It Exists

- Retrieve evidence-backed context packs instead of whole files.
- Avoid repeated files, symbols, chunks, and evidence lines in long agent sessions.
- Explain why each file, symbol, route, test, or snippet was selected.
- Keep a local SQLite/FTS5 code graph for search, references, calls, routes, tests, and impact.
- Stay local-first by default; no telemetry and no external code upload unless you configure embeddings.

## What Works Today

- Local CLI: `init`, `index`, `query`, `status`, `doctor`, `serve`, `setup`, `uninstall`, `watch`, `sync`, `register`, `list`, `unregister`, `open`, `wiki`
- 25 MCP tools covering navigation, search, symbol lookup, call/dependency graphs, impact analysis, route maps, communities, processes, related tests, context packs, project facts, context ledger tracking, and multi-repo aggregation
- TypeScript/JavaScript-first graph indexing with symbol chunks and line-based locations
- Route mapping for Next.js App Router handlers, FastAPI decorators, and TypeScript/JavaScript `fetch()` references
- Process detection (HTTP route → call graph → terminal) and lightweight Louvain community detection over the indexed graph
- Adaptive output budget that sizes `get_context_pack` / `plan_context` / `explain_module` based on the indexed node count
- Stale file banner prepended to `get_context_pack` / `search_code` / `find_definition` when the watcher has pending sync work
- ContextLedger tracking for returned files/symbols/chunks, including pre-pack search reranking and `get_context_pack` session deltas
- Evidence-first context packs: returned symbols/snippets include compact evidence lines and repeated evidence is removed when `avoidRepeated` is active
- SQLite/FTS keyword retrieval, graph expansion, and optional LanceDB vector retrieval when embeddings are configured
- Multi-repo registry with `get_unified_repo_map` for cross-repo navigation and shared-dependency suggestions

## Current Limits

- Vector search is opt-in. With `--embedding none`, `hybrid` means keyword retrieval plus graph expansion. With `--embedding ollama` or `--embedding openai`, `index --full` generates symbol chunk embeddings and `hybrid` uses keyword + vector + graph. Query-time embeddings require the configured provider to be reachable.
- TS/JS are the reliable first-stage languages. Python and Go symbol indexing are present, but their call/dependency graph quality is not first-stage acceptance scope.
- Route mapping is deterministic and local: it recognizes literal routes first. Dynamic fetch URLs and framework-specific routing beyond Next.js App Router/FastAPI are reported as future scope.
- TSX parsing uses the bundled `tree-sitter-tsx.wasm`. Run `code-memory doctor` to verify grammar availability in custom installs.
- Existing v0.1 indexes should be rebuilt with `code-memory index --full` after upgrading because symbol ranges now use 1-based line numbers.

## CLI Commands

- `code-memory init` — initialize a project for indexing (`init -i` for an interactive setup, `--embedding none|ollama|openai` to choose the embedding provider).
- `code-memory index` — build or update the local index (`--full` for a clean rebuild, `--workers auto|N` to control the parse pool).
- `code-memory query` — ad-hoc search the index from the terminal (`--mode hybrid|fts|vector|graph`).
- `code-memory status` — show index status, freshness, and last sync timestamp.
- `code-memory doctor` — diagnose config, schema, and grammar availability.
- `code-memory serve` — start the MCP stdio server (add `--watch` to keep the index in sync with file changes).
- `code-memory setup` — register Code Memory with a coding agent (e.g. `codex`, `claude-code`); supports `--dry-run`.
- `code-memory uninstall` — remove Code Memory entries from a coding agent.
- `code-memory watch` — keep the index in sync with file changes in the background.
- `code-memory sync` — manually re-sync the index on demand.
- `code-memory register` / `list` / `unregister` / `open` — manage the multi-repo registry stored at `~/.code-memory/registry.json`.
- `code-memory wiki` — generate `.code-memory/wiki.json` (project summary, communities, processes, routes, and external dependencies) for downstream LLM consumption. Exits non-zero if the index is stale — run `code-memory index` first.

## MCP Tools

Code Memory ships 25 MCP tools grouped by purpose:

**Navigation & discovery**
- `get_project_card` — short project summary card (purpose, stack, top routes).
- `get_repo_map` — high-level repo map; files are grouped by community, with cohesion scores in each section header.

**Search**
- `search_code` — hybrid FTS + vector + graph search with intent diagnostics, score breakdown, and ledger penalties.
- `search_symbols` — symbol-only search with kind and visibility filters.

**Symbol navigation**
- `find_definition` — locate the definition of a symbol by name.
- `find_references` — find all call and import sites that reference a symbol.

**Graph analysis**
- `get_call_graph` — outgoing + incoming call edges for a symbol.
- `get_dependency_graph` — import-level module dependency subgraph.
- `impact_analysis` — transitive blast radius of changing a symbol.
- `get_route_map` — list HTTP routes with their handler symbols.
- `get_community` — get a community (cluster of related symbols) by name, with cohesion, keywords, and members.
- `get_process` — get an end-to-end process (HTTP route / `main` / `export default`) with its ordered call steps.

**Testing**
- `get_related_tests` — list tests that exercise a given symbol.

**Context**
- `plan_context` — classify the task and recommend a `get_context_pack` call shape, sized by the adaptive output budget.
- `get_context_pack` — return an evidence-backed context package, filtered through the adaptive output budget and prepended with a stale-file banner when the watcher has pending sync work.

**Memory**
- `remember_project_fact` — persist a project fact into the local memory store.
- `invalidate_memory` — drop facts whose underlying files have changed.

**Context ledger**
- `mark_context_used` — record files, symbols, chunks, and evidence IDs returned to the agent.
- `get_context_delta` — diff candidate context against the session ledger.
- `avoid_repeated_context` — keep/drop recommendation for repeated context.
- `explain_why_this_context` — explain whether a file, symbol, or chunk is new or already seen.
- `compact_session_context` — summarize what the session has consumed.
- `reset_context_session` — clear a session ledger when the task materially changes.

**Understanding**
- `explain_module` — return a structured explanation of a module or file, truncated to the adaptive output budget.

**Multi-repo**
- `get_unified_repo_map` — aggregate overview across all registered repos, including `crossRepoSuggestions` for shared dependencies. Accepts `repos: [...]` to filter the set.

## Install And Build

```bash
npm install
npm run build
```

For local development from this repository:

```bash
node dist/index.js --help
```

After package installation, use:

```bash
code-memory --help
```

## Quick Start

From the project you want to index:

```bash
npx code-memory@latest init -i --embedding none
code-memory doctor
code-memory status
code-memory query "login flow"
```

Connect an agent with a dry run first:

```bash
code-memory setup --agent codex --dry-run
code-memory setup --agent codex
code-memory serve --watch
```

Agent setup only maintains a Code Memory marker block or JSON marker fields. Re-running setup is idempotent, and `code-memory uninstall --agent <name>` removes only Code Memory entries.

Example MCP server config:

```json
{
  "mcpServers": {
    "code-memory": {
      "command": "code-memory",
      "args": ["serve", "--watch"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

Optional local vector search with Ollama:

```bash
code-memory init --embedding ollama --embedding-model nomic-embed-text
code-memory doctor
code-memory index --full
code-memory query "token creation" --mode hybrid
code-memory query "token creation" --mode vector
```

Optional OpenAI embeddings:

```bash
export CODE_MEMORY_EMBEDDING_API_KEY="sk-..."
code-memory init --embedding openai --embedding-model text-embedding-3-small
code-memory index --full
```

PowerShell:

```powershell
$env:CODE_MEMORY_EMBEDDING_API_KEY = "sk-..."
code-memory init --embedding openai --embedding-model text-embedding-3-small
code-memory index --full
```

Provider secrets are resolved from environment variables first. For embeddings, Code Memory checks `CODE_MEMORY_EMBEDDING_API_KEY`, then provider-specific variables such as `OPENAI_API_KEY`, then the legacy `.code-memory/config.json` `embedding.apiKey` field. For LLM summaries, it checks `CODE_MEMORY_LLM_API_KEY`, then `OPENAI_API_KEY`, then `llm.apiKey`. Plaintext `apiKey` values in config are kept only as a compatibility fallback and are not the recommended setup. Base URLs follow the same env-first pattern: `CODE_MEMORY_EMBEDDING_BASE_URL` / `CODE_MEMORY_LLM_BASE_URL`, then provider-specific variables such as `OPENAI_BASE_URL`, then config `baseUrl`.

## Large Repo Indexing

The indexer uses native SQLite with WAL/FTS5 and a worker-thread parse pool. The default worker setting is `auto` (`min(available CPU cores - 1, 8)`) to avoid loading too many Tree-sitter/WASM workers on high-core machines. Use `--workers 0` only for debugging or deterministic test runs, or pass an explicit number when you want to trade memory for throughput.

```bash
code-memory index --full --workers auto
code-memory index --full --workers 4 --embedding-batch-size 50 --embedding-concurrency 2
```

After upgrading an older index, run a full rebuild:

```bash
code-memory index --full
```

For local scale checks from this repository:

```bash
npm run build
npm run benchmark:index -- --files 2000 --workers auto --embedding none
```

`code-memory doctor` checks the native SQLite driver, WAL, FTS5, worker_threads, grammar availability, and whether the current schema needs a full re-index.

Start the MCP server from the indexed project root with automatic sync:

```bash
code-memory serve --watch
```

`serve` currently supports MCP stdio only. The compatibility flag `--no-mcp` is rejected with an `UNSUPPORTED_TRANSPORT` error until an alternate transport exists. Startup errors are classified separately for missing config, invalid config JSON, watch startup failures, and MCP startup failures.

## Context Ledger

Use the ledger tools when an agent wants to avoid repeating context in one task/session:

- `plan_context`: classify the task, show the graph edge profile, vector/index status, ledger history, and the recommended `get_context_pack` call before fetching context.
- `get_context_pack`: pass `sessionId` to record returned context; pass `avoidRepeated: true` to omit files, symbols, and snippets already returned in that session.
- `get_context_pack.levels`: cap returned detail (`L0` project card through `L4` code snippets) when a task needs a smaller context package.
- `search_code`: accepts `intent`, `sessionId`, and `avoidRepeated`; output includes intent diagnostics, graph profile, score breakdown, and ledger penalties.
- `mark_context_used`: record files, symbols, chunks, token estimate, evidence IDs, and optional feedback.
- `get_context_delta`: compare candidate context with what was already returned.
- `avoid_repeated_context`: get a keep/drop recommendation.
- `explain_why_this_context`: explain whether a file, symbol, or chunk is new or repeated.
- `compact_session_context`: summarize what the session has already consumed.
- `reset_context_session`: clear a session ledger when the task materially changes.

## Multi Repo Registry

Register local repositories so repo-aware MCP tools can route by repo name or cwd:

```bash
code-memory register --name my-app --dry-run
code-memory register --name my-app
code-memory list --dry-run
code-memory list --json
code-memory open my-app
code-memory unregister my-app --dry-run
code-memory unregister my-app
```

`register`, `list`, and `unregister` support `--dry-run` for safe agent setup scripts. The registry is stored at `~/.code-memory/registry.json` unless `CODE_MEMORY_GLOBAL_HOME` is set. Repo-aware MCP tools accept `repo` as a registered name or repository root path. Current coverage includes `get_project_card`, `search_code`, `search_symbols`, `find_definition`, `find_references`, `get_call_graph`, `get_dependency_graph`, `impact_analysis`, `get_related_tests`, `get_repo_map`, `plan_context`, `get_context_pack`, and the Context Ledger tools (`mark_context_used`, `get_context_delta`, `avoid_repeated_context`, `explain_why_this_context`, `compact_session_context`, `reset_context_session`):

```json
{
  "query": "login flow",
  "repo": "my-app",
  "searchMode": "hybrid"
}
```

## Language Maturity

| Language / framework | Symbols | Imports | References | Calls | Routes | Tests | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | yes | yes | yes | yes | Next.js | yes | stable |
| JavaScript | yes | yes | yes | yes | Next.js | yes | stable |
| Python | yes | partial | partial | partial | FastAPI | partial | beta |
| Go | yes | partial | partial | partial | no | partial | beta |

Weak or inferred graph edges are marked with lower confidence and should appear in diagnostics, not as exact default call-graph evidence.

## Local Storage And Privacy

Code Memory writes `.code-memory/` inside the indexed project. It can contain SQLite metadata, symbol chunks, call evidence, memories, ledger history, and optional vector embeddings. Keep `.code-memory/` out of git. The tool does not upload code unless you configure an embedding provider that sends text to an external API.

## Grammar Resolution

Parser grammars are resolved in this order:

1. `CODE_MEMORY_GRAMMARS`
2. `grammars/` in the indexed project
3. `grammars/` bundled with the package

Run:

```bash
code-memory doctor
```

to check config, index presence, and grammar availability.

## License

MIT
