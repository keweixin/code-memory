# Stale File Banner

## What Is the Stale File Banner?

When the file watcher detects that files have been modified but the index hasn't caught up yet, Code Memory prepends a warning banner to MCP tool responses. This helps AI agents know when they should read a file directly instead of relying on potentially stale indexed content.

## When Does It Appear?

The banner appears when:
1. `code-memory serve --watch` is running
2. Files have been modified on disk
3. The incremental index hasn't processed those changes yet

## Which Tools Show the Banner?

Five MCP tools include the stale file banner:
- `get_context_pack` — context packages
- `search_code` — code search results
- `find_definition` — symbol definition lookup
- `plan_context` — context planning
- `explain_module` — module explanations

## Banner Format

When pending files are referenced in the response:
```
⚠️  Stale file warning:
The following files were modified but the index has not caught up yet.
For accurate content, Read the file directly:

  - src/auth.ts (5s ago)
  - src/user.ts (12s ago) [indexing...]
```

When there are additional pending files not referenced in the response, a footer appears:
```
--- Other pending files (not in this response) ---
  - src/utils.ts (8s ago)
  ...and 3 more
```

## How to Resolve

The banner disappears automatically once the watcher processes all pending files. No manual action is needed. If the banner persists, check the watcher status with `code-memory status`.
