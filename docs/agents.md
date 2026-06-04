# Agents

Supported agents:

| Agent | Command |
|---|---|
| Cursor | `setup --agent cursor --project .` |
| Claude | `setup --agent claude --project .` |
| Codex | `setup --agent codex --project .` |
| Gemini | `setup --agent gemini --project .` |
| OpenCode | `setup --agent opencode --project .` |

Use `--agent auto` only after an agent config already exists. Auto-detection succeeds when exactly one supported config is found; if none or multiple are found, setup prints explicit commands and stops without registering or writing partial config.

Runtime options:

| Runtime | MCP command |
|---|---|
| `npx` | `CODE_MEMORY_PROJECT=<absolute project> npx -y @keweixin/code-memory@latest serve --watch --auto-project` |
| `global` | `CODE_MEMORY_PROJECT=<absolute project> code-memory serve --watch --auto-project` |
| `local` | `CODE_MEMORY_PROJECT=<absolute project> node <absolute dist/index.js> serve --watch --auto-project` |

Add `--bind-project` during setup only when you want the generated MCP config to use `--project <absolute-path>` and stay fixed to one repository.

Agent workflow:

1. Call `resolve_project` before Read/Grep/Glob.
2. If the project is missing, stale, or unregistered, call `bootstrap_project`, `sync_project`, or `register_project`.
3. Call `resolve_project` again, then `plan_context` and `get_context_pack`.
4. Parse core tool results as structured JSON: `status`, `project`, `freshness`, `data`, `nextAction`, `display`.
5. After a ready `get_context_pack`, only use Read on `data.trustContract.allowedNextReads` paths and ranges unless confidence is low or freshness is stale.
6. Do not run broad Grep/Glob after a ready context pack; use `search_code` or `search_symbols` for precision instead.
