# Multi-Repo Registry

Code Memory supports indexing multiple repositories and querying them through a unified interface.

## Registering Repositories

```bash
# Register a repository
code-memory register my-project /path/to/my-project

# List all registered repositories
code-memory list

# Remove a repository from the registry
code-memory unregister my-project
```

## Registry Storage

The registry is stored at `~/.code-memory/registry.json` by default. You can override this location with the `CODE_MEMORY_GLOBAL_HOME` environment variable:

```bash
export CODE_MEMORY_GLOBAL_HOME=/custom/path
code-memory register my-project /path/to/my-project
# Registry stored at /custom/path/registry.json
```

## Multi-Repo MCP Tool

The `get_unified_repo_map` MCP tool aggregates overviews across all registered repositories:

- Per-repo: name, path, primary language, node count, top 3 communities, top 3 processes, last-indexed timestamp
- Cross-repo: shared external dependencies appearing in 3+ repos

You can filter by repo name:
```json
{ "repos": ["payment", "user"] }
```

The filter uses case-insensitive substring matching, so `"payment"` matches `"payment-service"`.

## Per-Repo Indexing

Each repository has its own SQLite database at `<repo-root>/.code-memory/index.db`. Indexing is per-repo:

```bash
cd /path/to/my-project
code-memory init --embedding none
code-memory index --full
```
