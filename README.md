# Code Memory

Code Memory is a local MCP-first code intelligence engine for coding agents. It indexes a project into files, symbols, chunks, imports, calls, references, and session context history so agents can retrieve precise evidence instead of repeatedly reading whole files.

## What Works Today

- Local CLI: `init`, `index`, `query`, `status`, `doctor`, `serve`
- MCP tools for repo maps, search, definitions, references, call/dependency graphs, impact, related tests, context packs, project facts, and context ledger tracking
- TypeScript/JavaScript-first graph indexing with symbol chunks and line-based locations
- ContextLedger tools to record returned files/symbols/chunks and calculate context deltas for a session
- SQLite/FTS keyword retrieval plus graph expansion

## Current Limits

- Vector search is not enabled yet. `hybrid` currently means keyword retrieval plus graph expansion; LanceDB/embedding code is experimental and not wired into indexing or querying.
- TS/JS are the reliable first-stage languages. Python and Go symbol indexing are present, but their call/dependency graph quality is not first-stage acceptance scope.
- TSX parsing requires `tree-sitter-tsx.wasm`. Run `code-memory doctor` to verify whether the grammar is available.
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
code-memory index --full
code-memory status
code-memory query "login flow"
```

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
