# Agents

Supported agents:

| Agent | Command |
|---|---|
| Cursor | `setup --agent cursor --project .` |
| Claude | `setup --agent claude --project .` |
| Codex | `setup --agent codex --project .` |
| Gemini | `setup --agent gemini --project .` |
| OpenCode | `setup --agent opencode --project .` |

Runtime options:

| Runtime | MCP command |
|---|---|
| `npx` | `npx -y @keweixin/code-memory@latest serve --watch --auto-project` |
| `global` | `code-memory serve --watch --auto-project` |
| `local` | `node <absolute dist/index.js> serve --watch --auto-project` |

Add `--bind-project` during setup only when you want the generated MCP config to use `--project <absolute-path>` and stay fixed to one repository.
