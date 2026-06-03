# Troubleshooting

| Problem | Fix |
|---|---|
| `npx` cannot find Code Memory | Check npm access and Node.js >= 20 |
| Node version too old | Install Node.js 20 or 22 |
| `better-sqlite3` install fails | Use a supported Node version and rebuild native dependencies |
| Windows permission denied | Run setup in a writable project directory |
| MCP server does not start | Run `code-memory doctor --project .` |
| IDE cwd is wrong | Re-run setup with `--project /absolute/path` |
| Index is empty | Run `code-memory bootstrap --project .` |
| Query has no results | Run `code-memory status --project . --staleness`, then `sync` or `bootstrap` |
| Hook is too slow | Set `CODE_MEMORY_HOOK_DISABLED=1` |
| Embedding key missing | Set `CODE_MEMORY_EMBEDDING_API_KEY` or `OPENAI_API_KEY` |

