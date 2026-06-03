# MCP Tools

Recommended order:

```text
plan_context
-> get_context_pack or search_code
-> search_symbols
-> find_definition / find_references
-> impact_analysis
-> get_related_tests
-> remember_project_fact / invalidate_memory
```

Every MCP tool can be run from the CLI:

```bash
code-memory tool --list --project .
code-memory tool plan_context --project . --args "{\"query\":\"find auth flow\"}"
```

Use `impact_analysis` before editing shared symbols, public contracts, routes, config loaders, parsers, or index lifecycle code.

