# Code Memory

> **Autonomous knowledge graph for AI coding agents.** Zero-command setup, self-healing stale memory, evidence-backed context, and multi-repo awareness — all local-first.

```bash
# Zero-command: AI handles everything
npx code-memory serve --watch

# Or manual one-time setup
npx code-memory@latest init && npx code-memory@latest index --full
```

---

## What It Does

Code Memory gives AI agents **persistent memory and code understanding** that survives across sessions. It builds a local SQLite knowledge graph of your entire codebase — symbols, calls, imports, routes, tests, and project facts — then serves it through 26 MCP tools.

**Three killer features AI agents actually need:**

| Capability | Without Code Memory | With Code Memory |
|---|---|---|
| New project indexing | AI crashes, user runs commands | **AI auto-initializes via bootstrap protocol** |
| Code changed, memory stale | AI uses outdated facts silently | **Auto-detects staleness, pushes `[CRITICAL ALERT]` banner** |
| Multi-repo work | Wrong database, wrong answers | **`repo` parameter routes every tool to the correct DB** |
| Repeated context in long sessions | Wastes tokens on same code | **Context Ledger tracks what was shown, deduplicates** |
| "Why did you include this file?" | No explanation | **Every snippet comes with evidence lines** |

---

## Quick Start

### 1. Install

```bash
npm install -g code-memory
```

### 2. Start the MCP server (AI handles the rest)

```bash
cd your-project
code-memory serve --watch
```

That's it. The first time AI connects, it will:
1. Detect no index exists → auto-guide initialization
2. Once indexed → all 26 tools work immediately
3. As you edit code → watcher auto-updates, stale memories get flagged

### MCP Config

Add to your IDE's MCP settings:

```json
{
  "mcpServers": {
    "code-memory": {
      "command": "npx",
      "args": ["code-memory@latest", "serve", "--watch"]
    }
  }
}
```

No `cwd` needed — `npx` inherits the IDE workspace directory automatically. Opens in project A → serves A. Opens in project B → serves B.

Or if you prefer a fixed path:

```json
{
  "mcpServers": {
    "code-memory": {
      "command": "npx",
      "args": ["code-memory@latest", "serve", "--watch"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

---

## The Autonomous Workflow

```
You edit code → watcher auto-reindexes → MemoryManager degrades stale facts
                                                     ↓
AI starts new task → server-instructions force plan_context first
                                                     ↓
If index missing → [BOOTSTRAP PROTOCOL] guides AI to initialize
If code changed → [CRITICAL ALERT] banner warns AI about stale memories
                                                     ↓
AI auto-calls invalidate_memory + remember_project_fact
                                                     ↓
Clean context, fresh facts, zero human intervention
```

---

## 26 MCP Tools

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

## CLI Commands

```bash
code-memory init              # Initialize project for indexing
code-memory index             # Build/update index (--full for rebuild)
code-memory query "auth"      # Ad-hoc search from terminal
code-memory status            # Index freshness and stats
code-memory doctor            # Diagnose config, schema, grammar
code-memory serve --watch     # Start MCP server with file watcher
code-memory watch             # Background file watcher only
code-memory sync              # Manual re-sync on demand
code-memory wiki              # Export wiki.json for LLM consumption
code-memory register my-app   # Register repo for multi-repo routing
code-memory list              # List registered repos
code-memory unregister my-app # Remove from registry
```

---

## Language Support

| Language | Symbols | Imports | Calls | Routes | Tests | Status |
|---|---|---|---|---|---|---|
| TypeScript | yes | yes | yes | Next.js | yes | stable |
| JavaScript | yes | yes | yes | Next.js | yes | stable |
| Python | yes | partial | partial | FastAPI | partial | beta |
| Go | yes | partial | partial | — | partial | beta |

TSX parsing uses bundled `tree-sitter-tsx.wasm`. Weak/inferred edges are flagged with lower confidence scores.

---

## Vector Search (Optional)

```bash
# Ollama (local, free)
code-memory init --embedding ollama --embedding-model nomic-embed-text
code-memory index --full

# OpenAI
$env:CODE_MEMORY_EMBEDDING_API_KEY = "sk-..."
code-memory init --embedding openai --embedding-model text-embedding-3-small
code-memory index --full
```

Secrets are resolved from env vars first: `CODE_MEMORY_EMBEDDING_API_KEY` → `OPENAI_API_KEY` → legacy config fallback.

---

## Multi-Repo

```bash
code-memory register --name backend
code-memory register --name frontend
```

Then pass `repo` to any tool:

```json
{ "query": "login flow", "repo": "backend", "searchMode": "hybrid" }
```

---

## Performance

2000-file project benchmarks:
- Parse throughput: 90+ files/sec
- Memory: under 900MB peak RSS
- FTS5 + graph search: sub-200ms P95

```bash
npm run benchmark:index -- --files 2000 --workers auto --embedding none
```

---

## Privacy

Everything runs locally. No telemetry. No code uploads. The only external calls are optional embedding API requests if you configure a provider. Keep `.code-memory/` in `.gitignore`.

---

## License

MIT
