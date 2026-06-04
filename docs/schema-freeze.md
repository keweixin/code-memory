# Schema Freeze

This document defines the public and storage contracts that must remain stable
for the v1 line. Additive changes are allowed after v1.0.0 only when older
clients keep working and `upgrade --project` or `repair --project` can recover
existing projects.

## Config Schema

Location: `.code-memory/config.json`

Required stable fields:

| Field | Contract |
|---|---|
| `projectName` | Human-readable project identity |
| `rootPath` | Absolute or project-root path used for index ownership |
| `ignore` | Scanner/watch ignore globs |
| `languages` | Indexed language allow-list |
| `embedding.provider` | `none`, `ollama`, or `openai` |
| `embedding.model` | Provider model name or `none` |
| `llm` | Optional summary provider config |
| `realtime.watch` | Watch service preference |
| `tokenBudgets` | Context packing defaults |

## Registry Schema

Location: `$CODE_MEMORY_GLOBAL_HOME/registry.json` or `~/.code-memory/registry.json`

```ts
type RegistryFile = {
  version: 1;
  repos: Array<{
    name: string;
    rootPath: string;
    registeredAt: string;
  }>;
};
```

Multiple registered repos are ambiguous unless callers pass `repo`, `project`,
`CODE_MEMORY_PROJECT`, or workspace roots. Resolver status must be
`needs_project_selection` instead of silently choosing the wrong repo.

## Index Schema

Location: `.code-memory/index.db`

Stable table groups:

| Group | Tables |
|---|---|
| Project identity | `index_metadata`, `files` |
| Symbols and graph | `symbols`, `edges`, `graph_edge_evidence` |
| Parse metadata | `file_imports`, `file_exports`, `call_refs`, `scope_bindings`, `type_relations` |
| Routes/processes | `route_endpoints`, `route_references`, `processes`, `process_steps`, `communities`, `community_members` |
| Retrieval | `chunks`, FTS tables, optional vector refs |
| Memory and ledger | `memories`, `context_ledger` |

Use `upgrade --project .` for compatible migrations, `repair --project .` for
missing/corrupt setup state, and `clean --project .` for sync/vacuum/watch-state
cleanup.

## Watch State Schema

Location: `.code-memory/watch-state.json`

```ts
type PersistedWatchState = {
  active: boolean;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  lastSyncAt: string | null;
  pendingFiles: string[];
  syncing: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
};
```

## MCP Tool Result Schema

Core MCP tools return one JSON object as their first text content:

```ts
type CodeMemoryToolResult<T> = {
  status:
    | 'ready'
    | 'needs_bootstrap'
    | 'needs_index'
    | 'needs_project_selection'
    | 'stale'
    | 'pending'
    | 'syncing'
    | 'error';
  project: { root: string; repoName: string; dbPath: string };
  freshness: {
    indexStatus: string;
    changedFiles: string[];
    lastIndexedAt: string | null;
    watcherActive: boolean;
    syncing: boolean;
    recommendedAction: string;
  };
  data: T;
  nextAction: { tool?: string; command?: string; reason: string };
  display: string;
};
```

Machine logic must use `status`, `project`, `freshness`, `data`, and
`nextAction`. `display` is human fallback only.

`freshness.changedFiles` is a machine-readable list of stale indexed paths when
the working tree no longer matches the index. It must include indexable files
whose content hash changed, newly relevant indexable files, and deleted indexed
files. After `sync_project` or `code-memory sync` refreshes the index,
`freshness.indexStatus` must return to `fresh` and `freshness.changedFiles` must
be empty. Watcher pending paths may be used as a fallback only when no stale
indexed paths are available.

## Resource URI Schema

Stable resources:

| URI | Contract |
|---|---|
| `code-memory://repos` | Global registry listing |
| `code-memory://repo/{name}/context` | Project orientation |
| `code-memory://repo/{name}/symbols` | Indexed symbols |
| `code-memory://repo/{name}/flows` | Execution flows |
| `code-memory://repo/{name}/schema` | SQLite schema map |
| `code-memory://repo/{name}/staleness` | Freshness diagnostics |
| `code-memory://repo/{name}/routes` | HTTP route map |
| `code-memory://repo/{name}/tests` | Related test map |
| `code-memory://repo/{name}/communities` | Community map |
| `code-memory://repo/{name}/memories` | Stored facts |

## Release Gate

Every release must pass version consistency, lint, build, full tests, coverage,
pack, smoke, audit, synthetic benchmark gate, real-repo dry-run, GitHub Release
creation, and npm latest verification.
