# Getting Started

Run setup from the project you want indexed:

```bash
npx -y @keweixin/code-memory@latest setup --agent cursor --project .
```

Verify:

```bash
npx -y @keweixin/code-memory@latest doctor --project .
npx -y @keweixin/code-memory@latest query "auth" --project .
```

Reload your IDE after setup. By default the generated MCP config starts a global `--auto-project` router, so the server can start even when the IDE cwd is not an initialized project. Use `setup --project . --bind-project` only when you want the MCP server fixed to one repository.
