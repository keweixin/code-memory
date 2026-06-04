# MCP Tools

Recommended order:

```text
resolve_project
-> bootstrap_project / sync_project / register_project when needed
-> plan_context
-> get_context_pack or search_code
-> search_symbols
-> find_definition / find_references
-> impact_analysis
-> get_related_tests
-> mark_context_used / get_context_delta / avoid_repeated_context
-> remember_project_fact / invalidate_memory
```

Use `resolve_project` first for a new task, repo switch, missing index, stale
index, or cwd mismatch. If it returns `needs_bootstrap`, `needs_index`, `stale`,
or `unknown`, call `bootstrap_project`, `sync_project`, or `register_project`
before expecting search results to be complete.

Core project/retrieval tools return a structured JSON envelope:

```ts
type CodeMemoryToolResult<T> = {
  status: 'ready' | 'needs_bootstrap' | 'needs_index' | 'needs_project_selection' | 'stale' | 'pending' | 'syncing' | 'error';
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

Parse `status`, `project`, `freshness`, `data`, and `nextAction` for agent control flow. Use `display` only for human-readable fallback text.

Graph-backed tools put edge trust data in `data.edges`, not in `display`.
Each edge may include `confidence`, collapsed `evidence`, `provenance`, and
per-site `evidenceRecords` with `filePath`, `line`, `column`, `evidence`, and
`provenance`. Treat only `provenance: "parser" | "resolver" | "framework"` as
strong evidence; `heuristic` edges require confirmation before risky edits.

`freshness.changedFiles` is the bounded machine-readable stale file list. It
contains indexable paths whose indexed hash is stale, newly relevant files, or
deleted indexed files. After `sync_project` refreshes those paths,
`freshness.indexStatus` returns to `fresh` and `freshness.changedFiles` is empty.
Do not scrape `display` to discover stale paths.

After a ready `get_context_pack`, prefer `data.trustContract.allowedNextReads`:

```json
{
  "allowedNextReads": [
    {
      "path": "src/auth/session.ts",
      "reason": "contains createSession implementation",
      "lineRange": "12-68",
      "readPriority": "high"
    }
  ],
  "discouragedReads": [
    {
      "pattern": "whole repo grep",
      "reason": "context pack already found entry/service/test candidates"
    }
  ]
}
```

Only read outside `allowedNextReads` when confidence is low, freshness is stale, or the returned evidence is insufficient for the task.

`get_context_pack` automatically records context and returns
`data.contextPackId`, `data.sessionId`, `data.autoRecorded`, and
`data.repeatedContext`. Pass a stable `sessionId` for multi-turn delta behavior.
If you send context manually from `search_code`, resources, or CLI output, call
`mark_context_used` with the files/symbols/chunks you returned.
Before sending more context for the same session, call `get_context_delta` or
`avoid_repeated_context` to prefer new evidence.

Every MCP tool can be run from the CLI:

```bash
code-memory tool --list --project .
code-memory tool plan_context --project . --args "{\"query\":\"find auth flow\"}"
```

Use `impact_analysis` before editing shared symbols, public contracts, routes, config loaders, parsers, or index lifecycle code.

## Core Tools

| Tool | When to use | After this |
|---|---|---|
| `resolve_project` | First call for a new task, repo switch, missing index, stale index, or cwd mismatch | `plan_context` if ready, otherwise `bootstrap_project`, `sync_project`, or `register_project` |
| `bootstrap_project` | Initialize or repair a project from MCP without requiring a startup database | `resolve_project`, then `plan_context` |
| `sync_project` | Incrementally refresh a stale project from MCP without requiring a startup database | `resolve_project`, then `plan_context` |
| `register_project` | Add the resolved project to the global registry so repo routing is stable | `resolve_project`, then `plan_context` |
| `plan_context` | Classify a task and choose retrieval routes | `get_context_pack` or `search_code` |
| `get_context_pack` | Return bounded evidence with trust contract and snippets | `search_symbols`, then `mark_context_used` only for context sent outside the pack |
| `search_code` | Ranked code search when you need candidate files/snippets | `search_symbols` for exact names |
| `search_symbols` | Locate named functions/classes/types | `find_definition` or `find_references` |
| `find_definition` | Inspect an exact symbol definition | `impact_analysis` before editing |
| `find_references` | Inspect known uses of a symbol | `impact_analysis` before editing |
| `impact_analysis` | Estimate blast radius before changes | `get_related_tests` |
| `get_related_tests` | Pick narrow validation commands | Run tests outside MCP |

## Context Ledger Tools

| Tool | When to use | After this |
|---|---|---|
| `mark_context_used` | Record manually returned files, symbols, chunks, tokens, or evidence for a session | `get_context_delta` before sending more context |
| `get_context_delta` | Compare candidate context against prior session context | Return new/kept context, then mark it used if manual |
| `avoid_repeated_context` | Get a concise keep/drop recommendation | Send kept context only |
| `explain_why_this_context` | Explain whether one item is new or repeated and optionally apply feedback | Adjust retrieval or call `get_context_delta` |
| `compact_session_context` | Summarize what a long session already saw | Use the summary instead of rereading snippets |
| `reset_context_session` | Start a materially new task without old repetition penalties | Restart with `resolve_project -> plan_context` |
