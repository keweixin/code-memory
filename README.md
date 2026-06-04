# Code Memory

Local-first code intelligence for AI coding agents: project map, symbol search, impact analysis, related tests, and MCP integration from one setup command.

## 30 Second Quick Start

Current source version: `0.4.1`.

Published npm status can lag the repository. Check before using `@latest`:

```bash
npm view @keweixin/code-memory version
```

If npm reports a version older than `0.4.1`, the GitHub source is ahead of the published package and `npx @keweixin/code-memory@latest` will not include the latest global MCP watch routing, multi-repo project selection, structured real-repo benchmark metrics, structured MCP tool results, allowed-read constraints, benchmark gate fixes, CLI mirror hardening, lifecycle command coverage, or strict setup auto-agent selection yet.

Run this from the project you want an agent to understand:

```bash
npx -y @keweixin/code-memory@latest setup --agent cursor --project .
```

Then verify the installation:

```bash
npx -y @keweixin/code-memory@latest doctor --project .
```

Reload your IDE after setup. The generated MCP config starts a global router, so the MCP server can start even when the IDE current working directory is not an initialized project.

## Supported Agents

`setup` supports:

| Agent | Config target |
|---|---|
| `cursor` | `.cursor/mcp.json` |
| `claude` | `CLAUDE.md` plus optional Claude Code hook files |
| `codex` | `~/.codex/config.toml` |
| `gemini` | `.gemini/settings.json` |
| `opencode` | `opencode.json` |

Use an explicit `--agent` for first-run setup. `--agent auto` only succeeds when exactly one supported agent config already exists; if none or multiple are detected, setup prints candidate commands instead of silently choosing the wrong target.

The default runtime is `npx`, which avoids global installs:

```json
{
  "command": "npx",
  "args": ["-y", "@keweixin/code-memory@latest", "serve", "--watch", "--auto-project"],
  "env": {
    "CODE_MEMORY_PROJECT": "/absolute/path/to/project"
  }
}
```

Use a fixed project server only when you explicitly want the MCP process bound to one repository:

```bash
npx -y @keweixin/code-memory@latest setup --agent cursor --project . --bind-project
```

Advanced runtime choices:

```bash
npx -y @keweixin/code-memory@latest setup --agent cursor --project . --runtime npx
npx -y @keweixin/code-memory@latest setup --agent cursor --project . --runtime global
npx -y @keweixin/code-memory@latest setup --agent cursor --project . --runtime local
```

## What Setup Does

`setup --project <path>` is the main entry point. It:

1. Resolves the project root to an absolute path.
2. Runs safe bootstrap unless `--no-bootstrap` is passed.
3. Registers the project in the global Code Memory registry for stable repo routing.
4. Writes the selected agent MCP config with `CODE_MEMORY_PROJECT` as the default project identity.
5. Writes managed Code Memory blocks to `AGENTS.md` and `CLAUDE.md`.
6. Installs Code Memory task skills under `.claude/skills/code-memory/`.
7. Installs the minimal Claude Code PreToolUse hook when enabled.
8. Runs `doctor`.
9. Prints the next action.

Useful variants:

```bash
npx -y @keweixin/code-memory@latest setup --agent cursor --project . --no-bootstrap
npx -y @keweixin/code-memory@latest setup --agent cursor --project . --dry-run
npx -y @keweixin/code-memory@latest analyze --project .
```

Use `analyze` when you want the index plus project AI context files without writing an agent MCP config.

## Verify Success

```bash
npx -y @keweixin/code-memory@latest status --project .
npx -y @keweixin/code-memory@latest doctor --project .
npx -y @keweixin/code-memory@latest query "auth" --project . --json
```

If the MCP server is started directly, `serve --watch` also performs safe cold-start bootstrap by default:

```bash
npx -y @keweixin/code-memory@latest serve --watch --project .
npx -y @keweixin/code-memory@latest serve --watch --auto-project
```

Strict mode for CI or debugging:

```bash
npx -y @keweixin/code-memory@latest serve --watch --project . --no-bootstrap
```

## Common Commands

| Command | Purpose |
|---|---|
| `setup --project .` | Full AI onboarding: bootstrap, MCP config, context files, skills, hooks, doctor |
| `setup --project . --bind-project` | Full onboarding with MCP config fixed to this project |
| `analyze --project .` | Bootstrap plus project AI context files, without agent MCP config |
| `bootstrap --project .` | Safe init/index lifecycle for MCP and first-run use |
| `init --project .` | Create `.code-memory/config.json` only |
| `index --project . --full` | Full re-index |
| `sync --project .` | Incremental index sync |
| `repair --project .` | Bootstrap, register, and repair project routing state |
| `upgrade --project .` | Apply storage/schema upgrades and report reindex needs |
| `clean --project .` | Sync, clear inactive watch state, and vacuum local storage |
| `watch --project .` | Watch files and keep the index fresh |
| `query "auth" --project .` | Search indexed code from the CLI |
| `tool --list --project .` | List MCP tools exposed through the CLI mirror |
| `tool <name> --project . --args '<json>'` | Run any MCP tool without an MCP client |
| `status --project . --json` | Machine-readable index status |
| `doctor --project . --json` | Machine-readable diagnostics |
| `register --project . --name my-repo` | Register a repo for multi-repo routing |
| `unregister --project .` | Remove a registered repo by path |
| `wiki --project .` | Export `.code-memory/wiki.json` |

## AI Workflow

Recommended tool order:

```text
New task / new repo
-> resolve_project

Missing / stale / unregistered project
-> bootstrap_project / sync_project / register_project
-> resolve_project again

Understand feature / find code
-> plan_context -> get_context_pack or search_code

Locate symbols
-> search_symbols -> find_definition / find_references

Prepare edits
-> impact_analysis

Prepare verification
-> get_related_tests

Avoid repeated context in long sessions
-> mark_context_used / get_context_delta / avoid_repeated_context

Preserve durable knowledge
-> remember_project_fact / invalidate_memory
```

Before using Read/Grep/Glob, call `resolve_project`, `plan_context`, and `get_context_pack`. Only use Read on files returned by Code Memory when extra source detail is needed. If `resolve_project` reports a missing, stale, or unregistered project, use `bootstrap_project`, `sync_project`, or `register_project` before falling back to shell commands or broad file scans.

The same workflow appears in MCP tool descriptions, response hints, generated `AGENTS.md` / `CLAUDE.md` blocks, generated skills, and doctor/setup guidance.

## MCP Tools

Every MCP tool also has a CLI mirror:

```bash
npx -y @keweixin/code-memory@latest tool plan_context --project . --args "{\"query\":\"find auth flow\"}"
```

Core tools:

| Tool | Purpose |
|---|---|
| `resolve_project` | Verify project identity, db path, index readiness, and next action |
| `bootstrap_project` | Initialize or repair a project from MCP without requiring a startup database |
| `sync_project` | Refresh a stale project from MCP without requiring a startup database |
| `register_project` | Add the resolved project to the global registry for stable repo routing |
| `plan_context` | Classify the task and choose the retrieval path |
| `get_context_pack` | Bounded evidence package for a task |
| `search_code` | Hybrid search across indexed snippets |
| `search_symbols` | Symbol-only search |
| `find_definition` | Exact definition location |
| `find_references` | Known references/callers/import sites |
| `impact_analysis` | Blast radius before edits |
| `get_related_tests` | Narrow validation targets |
| `mark_context_used` | Record manually returned files/symbols/chunks for a session |
| `get_context_delta` | Compare candidate context against what a session already saw |
| `avoid_repeated_context` | Keep/drop recommendation for candidate context |
| `explain_why_this_context` | Explain whether context is new/repeated and apply feedback |
| `compact_session_context` | Summarize prior session context |
| `reset_context_session` | Clear ledger entries when a new task starts |
| `get_process` | Execution flow/process trace |
| `get_repo_map` | Project map grouped by community |
| `remember_project_fact` | Save durable project knowledge |
| `invalidate_memory` | Remove stale facts |

## MCP Resources

Resources are read-only project maps. Tools are actions.

| Resource | Purpose |
|---|---|
| `code-memory://repos` | Registered repositories |
| `code-memory://repo/{name}/context` | Project identity, index status, languages, communities, workflow |
| `code-memory://repo/{name}/symbols` | Top indexed symbols |
| `code-memory://repo/{name}/flows` | Indexed execution flows |
| `code-memory://repo/{name}/schema` | Database schema map |
| `code-memory://repo/{name}/staleness` | Index freshness and changed-file diagnostics |
| `code-memory://repo/{name}/routes` | Indexed HTTP routes |
| `code-memory://repo/{name}/tests` | Indexed test files |
| `code-memory://repo/{name}/communities` | Detected code communities |
| `code-memory://repo/{name}/memories` | Stored project facts |

## Benchmarks

These are local benchmark results from this repository on Windows with Node 22 and embedding provider `none`. Treat them as regression baselines, not marketing claims.

| Metric | Result |
|---|---:|
| 2000-file index throughput | 91.6 files/s |
| 2000-file peak RSS | 446.5 MB |
| Agent benchmark task success | true |
| Agent benchmark key file recall | 1.00 |
| Agent benchmark evidence coverage | 1.00 |
| Agent benchmark hallucinated symbol rate | 0.00 |
| Agent benchmark stale failure rate | 0.00 |
| Context primary key file recall | 1.00 |
| Context primary evidence coverage | 1.00 |
| Context primary symbol recall | 0.825 |
| Context primary average search latency | 131 ms |

The context benchmark also reports ablation modes (`keyword_only`, `graph_only`) for diagnostics. Release gates enforce the primary production modes (`hybrid`, `hybrid_ledger`) plus the agent workflow.

Reproduce:

```bash
npm run benchmark:index -- --files 2000 --workers auto --embedding none > benchmark-index.json
npm run benchmark:context > benchmark-context.json
npm run benchmark:agent > benchmark-agent.json
npm run benchmark:gate -- --index benchmark-index.json --context benchmark-context.json --agent benchmark-agent.json
npm run benchmark:real-repos -- --dry-run
```

The real-repo benchmark runner reads `benchmark/real-repos.json`, clones pinned commits only when not in `--dry-run`, bootstraps each project, runs the same CLI mirror tools an agent would use, and reports `realRepoKeyFileRecall`, `realRepoEvidenceCoverage`, `relatedTestRecall`, `wrongProjectRouteRate`, and `staleFailureRate`. Full runs write `benchmark-results/real-repos.latest.json` and `benchmark-results/real-repos.summary.md`; release CI runs only the deterministic dry-run, while nightly/manual runs can use `--fail-on-threshold` for real scores. Use `--repo <name>` or `--task <id>` for focused runs.

## Language Support

| Language | Symbols | Imports | Calls | Routes | Tests | Status |
|---|---|---|---|---|---|---|
| TypeScript | yes | yes | yes | Next.js | yes | stable |
| JavaScript | yes | yes | yes | Next.js | yes | stable |
| Python | yes | partial | partial | FastAPI | partial | beta |
| Go | yes | partial | partial | beta | partial | beta |

## Privacy

Code Memory stores local snippets, metadata, call evidence, memories, ledger history, and optional vectors under `.code-memory/`. Keep `.code-memory/` out of git.

No telemetry is sent. External calls happen only when you configure an embedding provider that uses an external API.

## Troubleshooting

| Problem | Fix |
|---|---|
| `npx` cannot find the package | Verify Node.js >= 20 and npm network access |
| Node version is too old | Install Node.js 20 or 22 |
| `better-sqlite3` install fails | Use Node 20/22 and rebuild native dependencies with your package manager |
| Windows permission error | Run setup from a writable project directory |
| MCP server does not appear | Reload the IDE and run `doctor --project .` |
| IDE cwd is wrong | Re-run `setup --project /absolute/path/to/project` |
| No index exists | Run `bootstrap --project .` |
| Query returns no results | Run `status --project . --staleness`, then `sync --project .` or `bootstrap --project .` |
| Hook is too slow | Set `CODE_MEMORY_HOOK_DISABLED=1` |
| Embedding API key is missing | Use `CODE_MEMORY_EMBEDDING_API_KEY` or `OPENAI_API_KEY` |

More detailed docs:

- [Getting started](docs/getting-started.md)
- [Agents](docs/agents.md)
- [MCP tools](docs/mcp-tools.md)
- [Resources](docs/resources.md)
- [Schema freeze](docs/schema-freeze.md)
- [Hooks](docs/hooks.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Release](docs/release.md)
- [Language support](docs/language-support.md)

## Uninstall

```bash
npx -y @keweixin/code-memory@latest uninstall --agent cursor --project .
npx -y @keweixin/code-memory@latest uninstall --all --project .
```

Uninstall removes managed MCP config entries plus Code Memory managed project onboarding artifacts: generated context blocks, `.claude/skills/code-memory/`, and the generated Claude Code PreToolUse hook. It preserves user-owned content outside those managed blocks.

## Development

```bash
npm install
npm run build
npm test
npm run lint
npm run pack:check
npm run test:smoke
```

## License

MIT
