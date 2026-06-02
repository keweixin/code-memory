# Process and Community Detection

## What Is a Process?

A **Process** is an end-to-end execution flow in your codebase — the path a request takes from an entry point (HTTP route handler, `main()`, or exported `default` function) through the function call graph down to terminal nodes (database writes, network calls, throws, or process exits).

Processes let agents answer questions like:
- "What happens when a user submits the login form?"
- "Which functions does `GET /api/users/:id` call?"
- "Where does the data end up after this endpoint?"

### How Processes Are Built

The indexer walks outgoing `CALLS` and `IMPORTS` edges from each entry point using a BFS up to a depth of 10. The walk stops at terminal nodes (throw, process.exit, SQL INSERT/UPDATE/DELETE, db.execute). Each visited symbol becomes a `process_step` with an ordered integer step number.

Entry-point candidates, in priority order:
1. HTTP route handlers (e.g. Express `@app.get('/users/:id', ...)`, FastAPI `@app.get("/items/{id}")`)
2. Exported `main` functions
3. Exported `default` functions in `index.ts` / `index.js` / `main.ts` / `main.js`

### Querying Processes

Use the `get_process` MCP tool:

```json
{
  "name": "GET /users/:id"
}
```

The response returns the process metadata plus an ordered list of steps with `file:line` locations.

## What Is a Community?

A **Community** is a cluster of related symbols grouped by their call/import/extends graph connectivity. Code Memory uses a lightweight Louvain modularity algorithm to find communities with high internal density.

Communities let agents answer questions like:
- "What are the major functional areas of this codebase?"
- "Which symbols belong to the authentication subsystem?"
- "What are the most cohesive modules?"

### Community Metadata

Each community has:
- `name` — auto-generated from the most common keyword in member symbol names
- `cohesion` — a 0..1 score measuring the ratio of internal edges to total possible edges
- `symbolCount` — number of member symbols
- `keywords` — top 5 most common tokens from member symbol names
- `detectionMethod` — always `louvain` (v1)

### Querying Communities

Use the `get_community` MCP tool:

```json
{
  "name": "auth"
}
```

The response returns the community metadata plus all member symbols.

### Communities in `get_repo_map`

The `get_repo_map` output groups files by community at the top level. Each section header shows `[community: name (cohesion: 0.75)]` so agents can navigate by functional area.

## Performance

- Process detection runs once per full index and once per incremental index. For projects with N symbols and E edges, the walk is O(N + E) per entry point.
- Community detection runs once per full index. Louvain is O(N log N) per iteration with a default max of 10 iterations.
- Both are stored in the index, not recomputed on every query.

## Storage

| Table | Purpose |
|-------|---------|
| `processes` | One row per process (id, name, entry_point, framework, depth_limit, step_count) |
| `process_steps` | One row per step in a process (process_id, step number, symbol_id, file_id) |
| `communities` | One row per community (id, name, cohesion, symbol_count, keywords) |
| `community_members` | One row per symbol in a community (community_id, symbol_id, weight) |
