# Code Memory

Local-first code intelligence for AI coding agents: project map, symbol search, impact analysis, related tests, and MCP integration from one setup command.

## 30 Second Quick Start

Current source version: `0.3.0`.

Published npm status can lag the repository. Check before using `@latest`:

```bash
npm view code-memory version
```

If npm reports a version older than `0.3.0`, the GitHub source is ahead of the published package and `npx code-memory@latest` will not include the setup/bootstrap/tool mirror flow yet.

Run this from the project you want an agent to understand:

```bash
npx -y code-memory@latest setup --agent cursor --project .
```

Then verify the installation:

```bash
npx -y code-memory@latest doctor --project .
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

The default runtime is `npx`, which avoids global installs:

```json
{
  "command": "npx",
  "args": ["-y", "code-memory@latest", "serve", "--watch", "--auto-project"]
}
```

Use a fixed project server only when you explicitly want the MCP process bound to one repository:

```bash
npx -y code-memory@latest setup --agent cursor --project . --bind-project
```

Advanced runtime choices:

```bash
npx -y code-memory@latest setup --agent cursor --project . --runtime npx
npx -y code-memory@latest setup --agent cursor --project . --runtime global
npx -y code-memory@latest setup --agent cursor --project . --runtime local
```

## What Setup Does

`setup --project <path>` is the main entry point. It:

1. Resolves the project root to an absolute path.
2. Runs safe bootstrap unless `--no-bootstrap` is passed.
3. Writes the selected agent MCP config.
4. Writes managed Code Memory blocks to `AGENTS.md` and `CLAUDE.md`.
5. Installs Code Memory task skills under `.claude/skills/code-memory/`.
6. Installs the minimal Claude Code PreToolUse hook when enabled.
7. Runs `doctor`.
8. Prints the next action.

Useful variants:

```bash
npx -y code-memory@latest setup --agent cursor --project . --no-bootstrap
npx -y code-memory@latest setup --agent cursor --project . --dry-run
npx -y code-memory@latest analyze --project .
```

Use `analyze` when you want the index plus project AI context files without writing an agent MCP config.

## Verify Success

```bash
npx -y code-memory@latest status --project .
npx -y code-memory@latest doctor --project .
npx -y code-memory@latest query "auth" --project . --json
```

If the MCP server is started directly, `serve --watch` also performs safe cold-start bootstrap by default:

```bash
npx -y code-memory@latest serve --watch --project .
npx -y code-memory@latest serve --watch --auto-project
```

Strict mode for CI or debugging:

```bash
npx -y code-memory@latest serve --watch --project . --no-bootstrap
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
-> resolve_project -> plan_context

Understand feature / find code
-> get_context_pack or search_code

Locate symbols
-> search_symbols -> find_definition / find_references

Prepare edits
-> impact_analysis

Prepare verification
-> get_related_tests

Preserve durable knowledge
-> remember_project_fact / invalidate_memory
```

The same workflow appears in MCP tool descriptions, response hints, generated `AGENTS.md` / `CLAUDE.md` blocks, generated skills, and doctor/setup guidance.

## MCP Tools

Every MCP tool also has a CLI mirror:

```bash
npx -y code-memory@latest tool plan_context --project . --args "{\"query\":\"find auth flow\"}"
```

Core tools:

| Tool | Purpose |
|---|---|
| `resolve_project` | Verify project identity, db path, index readiness, and next bootstrap/index command |
| `plan_context` | Classify the task and choose the retrieval path |
| `get_context_pack` | Bounded evidence package for a task |
| `search_code` | Hybrid search across indexed snippets |
| `search_symbols` | Symbol-only search |
| `find_definition` | Exact definition location |
| `find_references` | Known references/callers/import sites |
| `impact_analysis` | Blast radius before edits |
| `get_related_tests` | Narrow validation targets |
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
| Agent benchmark key file recall | 0.60 |
| Agent benchmark evidence coverage | 0.60 |
| Agent benchmark hallucinated symbol rate | 0.00 |
| Agent benchmark stale failure rate | 0.00 |
| Context benchmark key file recall | 0.375 |
| Context benchmark evidence coverage | 0.400 |
| Context benchmark average search latency | 167 ms |

Reproduce:

```bash
npm run benchmark:index -- --files 2000 --workers auto --embedding none
npm run benchmark:context
npm run benchmark:agent
```

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
- [Hooks](docs/hooks.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Release](docs/release.md)
- [Language support](docs/language-support.md)

## Uninstall

```bash
npx -y code-memory@latest uninstall --agent cursor --project .
npx -y code-memory@latest uninstall --all --project .
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
