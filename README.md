# Code Memory

Code Memory is a local MCP-first code intelligence engine for coding agents. It indexes a project into files, symbols, chunks, imports, calls, references, and session context history so agents can retrieve precise evidence instead of repeatedly reading whole files.

## What Works Today

- Local CLI: `init`, `index`, `query`, `status`, `doctor`, `serve`
- MCP tools for repo maps, search, definitions, references, call/dependency graphs, impact, related tests, context packs, project facts, and context ledger tracking
- TypeScript/JavaScript-first graph indexing with symbol chunks and line-based locations
- ContextLedger tracking for returned files/symbols/chunks, including `get_context_pack` session deltas
- SQLite/FTS keyword retrieval, graph expansion, and optional LanceDB vector retrieval when embeddings are configured

## Current Limits

- Vector search is opt-in. With `--embedding none`, `hybrid` means keyword retrieval plus graph expansion. With `--embedding ollama` or `--embedding openai`, `index --full` generates symbol chunk embeddings and `hybrid` uses keyword + vector + graph. Query-time embeddings require the configured provider to be reachable.
- TS/JS are the reliable first-stage languages. Python and Go symbol indexing are present, but their call/dependency graph quality is not first-stage acceptance scope.
- TSX parsing uses the bundled `tree-sitter-tsx.wasm`. Run `code-memory doctor` to verify grammar availability in custom installs.
- Existing v0.1 indexes should be rebuilt with `code-memory index --full` after upgrading because symbol ranges now use 1-based line numbers.

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
code-memory init --embedding none
code-memory doctor
code-memory index --full --workers auto
code-memory status
code-memory query "login flow"
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
code-memory init --embedding openai --embedding-model text-embedding-3-small
# Set the apiKey field in .code-memory/config.json or use an OpenAI-compatible baseUrl before indexing.
code-memory index --full
```

## Large Repo Indexing

The indexer uses native SQLite with WAL/FTS5 and a worker-thread parse pool. The default worker setting is `auto` (`available CPU cores - 1`). Use `--workers 0` only for debugging or deterministic test runs.

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

Start the MCP server from the indexed project root:

```bash
code-memory serve
```

Example MCP server config:

```json
{
  "mcpServers": {
    "code-memory": {
      "command": "code-memory",
      "args": ["serve"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

## Context Ledger

Use the ledger tools when an agent wants to avoid repeating context in one task/session:

- `get_context_pack`: pass `sessionId` to record returned context; pass `avoidRepeated: true` to omit files, symbols, and snippets already returned in that session.
- `get_context_pack.levels`: cap returned detail (`L0` project card through `L4` code snippets) when a task needs a smaller context package.
- `mark_context_used`: record files, symbols, chunks, token estimate, evidence IDs, and optional feedback.
- `get_context_delta`: compare candidate context with what was already returned.
- `avoid_repeated_context`: get a keep/drop recommendation.
- `explain_why_this_context`: explain whether a file, symbol, or chunk is new or repeated.

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
