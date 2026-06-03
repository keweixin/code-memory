# Code Memory

> **Autonomous knowledge graph for AI coding agents.** Zero-command setup, self-healing stale memory, evidence-backed context, and multi-repo awareness — all local-first.

---

## Quick Start

Add this to your IDE's MCP settings, then reload:

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

Done. No `npm install`, no `cwd` path — `npx` auto-downloads and runs in whatever project you have open.

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
If no index → [BOOTSTRAP PROTOCOL] guides AI to npx code-memory@latest init && index --full
If code changed → [CRITICAL ALERT] warns AI about stale memories
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

## CLI Commands (via npx)

```bash
npx code-memory@latest init              # Initialize project
npx code-memory@latest index --full      # Full re-index
npx code-memory@latest query "auth"      # Ad-hoc search
npx code-memory@latest status            # Index freshness
npx code-memory@latest doctor            # Diagnose config
npx code-memory@latest serve --watch     # MCP server + file watcher
npx code-memory@latest watch             # Background watcher only
npx code-memory@latest register my-app   # Register for multi-repo
npx code-memory@latest list              # List registered repos
npx code-memory@latest unregister my-app # Remove from registry
npx code-memory@latest wiki              # Export wiki.json
```

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
