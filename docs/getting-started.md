# Getting Started

Run setup from the project you want indexed:

```bash
npx -y code-memory@latest setup --agent cursor --project .
```

Verify:

```bash
npx -y code-memory@latest doctor --project .
npx -y code-memory@latest query "auth" --project .
```

Reload your IDE after setup. The generated MCP config includes an absolute `--project` path, so IDE cwd does not matter.

