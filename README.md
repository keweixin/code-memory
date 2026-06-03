# Code Memory

> **Autonomous knowledge graph for AI coding agents.** Zero-command setup, self-healing stale memory, evidence-backed context, and multi-repo awareness — all local-first.

---

## Quick Start

Run setup from the project you want indexed, then reload your IDE:

```bash
npx code-memory@latest setup --agent codex
```

`setup` runs a safe bootstrap, writes an MCP config that uses `npx -y code-memory@latest serve --watch --project <absolute-path>`, and installs project AI context files under `AGENTS.md`, `CLAUDE.md`, and `.claude/skills/code-memory/`. The IDE does not need a global install and does not depend on its current working directory.

Use `analyze` when you want the index plus project AI context files without changing an agent MCP config:

```bash
npx code-memory@latest analyze --project .
```

Manual MCP config, if you prefer to edit settings yourself:

```json
{
  "mcpServers": {
    "code-memory": {
      "command": "npx",
      "args": ["-y", "code-memory@latest", "serve", "--watch", "--project", "/absolute/path/to/project"]
    }
  }
}
```

That's it. `serve --watch` auto-runs safe bootstrap on cold start: if no config exists it runs `init` + `index --full`; if config exists but no index exists it runs `index --full`; if an index exists it runs an incremental update before serving MCP.

Need strict startup for CI or debugging?

```bash
npx code-memory@latest serve --watch --no-bootstrap --project .
```

You can also run bootstrap manually:

```bash
npx code-memory@latest bootstrap --project .
```

---

## What It Does

**Three killer features AI agents actually need:**

| Capability | Without Code Memory | With Code Memory |
|---|---|---|
| New project, no index | AI crashes, human runs commands | **AI auto-initializes via bootstrap protocol** |
| Code changed, memory stale | AI uses outdated facts silently | **Auto-detects staleness, pushes `[CRITICAL ALERT]`** |
| Multi-repo work | Wrong database, wrong answers | **`repo` param routes every tool to correct DB** |
| Long session, repeated context | Wastes tokens on same code | **Context Ledger tracks & deduplicates** |
| "Why this file?" | No explanation | **Evidence lines on every snippet** |

---

## The Autonomous Workflow

```
You edit code → watcher auto-reindexes → MemoryManager degrades stale facts
                                                     ↓
AI starts new task → instructions force plan_context first
                                                     ↓
If no index → serve --watch auto-runs bootstrap, or [BOOTSTRAP PROTOCOL] guides AI to npx code-memory@latest bootstrap --project .
If code changed → [CRITICAL ALERT] warns AI about stale memories
                                                     ↓
AI auto-calls invalidate_memory + remember_project_fact
                                                     ↓
Clean context, fresh facts, zero human intervention
```

---

## 26 MCP Tools

Every tool description now includes `WHEN TO USE` / `AFTER THIS` guidance, and tool responses append a compact next-step hint. The default agent path is:

```text
plan_context -> get_context_pack/search_code -> search_symbols/find_definition -> impact_analysis -> get_related_tests
```

### Navigation & Discovery
| Tool | Purpose |
|---|---|
| `get_project_card` | Project identity card (stack, routes, file counts) |
| `get_repo_map` | Hierarchical file map grouped by community |
| `get_unified_repo_map` | Cross-repo aggregate with shared dependency suggestions |

### Search
| Tool | Purpose |
|---|---|
| `search_code` | Hybrid FTS + vector + graph search with intent diagnostics |
| `search_symbols` | Symbol-only search with kind/visibility filters |

### Symbol Navigation
| Tool | Purpose |
|---|---|
| `find_definition` | Locate symbol definition by name |
| `find_references` | All call/import sites referencing a symbol |

### Graph Analysis
| Tool | Purpose |
|---|---|
| `get_call_graph` | Outgoing + incoming call edges |
| `get_dependency_graph` | Module-level import dependency subgraph |
| `impact_analysis` | Transitive blast radius of changing a symbol |
| `get_route_map` | HTTP routes with handler symbols |
| `get_community` | Cluster of related symbols (Louvain communities) |
| `get_process` | End-to-end process trace (HTTP route → call chain) |

### Testing
| Tool | Purpose |
|---|---|
| `get_related_tests` | Tests exercising a given symbol |

### Context & Planning
| Tool | Purpose |
|---|---|
| `plan_context` | Classifies intent, recommends retrieval shape, detects repo readiness |
| `get_context_pack` | Evidence-backed context package with adaptive budget |
| `explain_module` | Structured module explanation |

### Memory (Long-term Facts)
| Tool | Purpose |
|---|---|
| `remember_project_fact` | Persist a project fact |
| `invalidate_memory` | Drop facts whose underlying code changed |

### Context Ledger (Session Deduplication)
| Tool | Purpose |
|---|---|
| `mark_context_used` | Record what was shown to the agent |
| `get_context_delta` | Diff candidate context vs session history |
| `avoid_repeated_context` | Keep/drop recommendation |
| `explain_why_this_context` | Is this file/symbol new or repeated? |
| `compact_session_context` | Summarize session consumption |
| `reset_context_session` | Clear session ledger |

---

## MCP Resources

Resources are read-only project maps for agents that need orientation before choosing a tool:

| Resource | Purpose |
|---|---|
| `code-memory://repos` | Registered repositories |
| `code-memory://repo/{name}/context` | Project identity, index status, languages, communities, recommended workflow |
| `code-memory://repo/{name}/symbols` | Top indexed symbols with file and line locations |
| `code-memory://repo/{name}/flows` | Indexed execution flows/processes |
| `code-memory://repo/{name}/schema` | Code Memory database schema map |

---

## CLI Commands (via npx)

```bash
npx code-memory@latest bootstrap         # Auto-init: detect + init + index
npx code-memory@latest analyze           # Bootstrap + AGENTS/CLAUDE + skills/hooks, no MCP config write
npx code-memory@latest setup             # Configure Codex MCP using npx + absolute --project
npx code-memory@latest setup --runtime global # Use a global code-memory binary instead of npx
npx code-memory@latest init              # Initialize project
npx code-memory@latest index --full      # Full re-index
npx code-memory@latest query "auth" --project . --json # Ad-hoc search / hook mirror
npx code-memory@latest tool --list --project . # List MCP tools available through CLI mirror
npx code-memory@latest tool plan_context --project . --args '{"task":"find auth flow"}' # Run any MCP tool from CLI
npx code-memory@latest status            # Index freshness
npx code-memory@latest doctor            # Diagnose config
npx code-memory@latest serve --watch     # MCP server + file watcher
npx code-memory@latest watch             # Background watcher only
npx code-memory@latest register my-app   # Register for multi-repo
npx code-memory@latest list              # List registered repos
npx code-memory@latest unregister my-app # Remove from registry
npx code-memory@latest wiki              # Export wiki.json
```

Every MCP tool has the same debugging path outside an agent: run `code-memory tool <tool_name> --project <path> --args '<json>'`. This keeps CLI and MCP behavior aligned because the command invokes the registered MCP tool handler directly.

---

## Language Support

| Language | Symbols | Imports | Calls | Routes | Tests | Status |
|---|---|---|---|---|---|---|
| TypeScript | yes | yes | yes | Next.js | yes | stable |
| JavaScript | yes | yes | yes | Next.js | yes | stable |
| Python | yes | partial | partial | FastAPI | partial | beta |
| Go | yes | partial | partial | — | partial | beta |

---

## Vector Search (Optional)

```bash
# Ollama (local, free)
npx code-memory@latest init --embedding ollama --embedding-model nomic-embed-text
npx code-memory@latest index --full

# OpenAI
$env:CODE_MEMORY_EMBEDDING_API_KEY = "sk-..."
npx code-memory@latest init --embedding openai --embedding-model text-embedding-3-small
npx code-memory@latest index --full
```

---

## Multi-Repo

```bash
npx code-memory@latest register --name backend
npx code-memory@latest register --name frontend
```

Then pass `repo` to any tool:

```json
{ "query": "login flow", "repo": "backend", "searchMode": "hybrid" }
```

---

## Privacy

Everything runs locally. No telemetry. No code uploads. The only external calls are optional embedding API requests. Keep `.code-memory/` in `.gitignore`.

---

## License

MIT
