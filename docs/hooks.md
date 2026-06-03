# Hooks

`setup` can install a minimal Claude Code PreToolUse hook.

The hook watches broad search tools such as `Grep`, `Glob`, and shell `rg` / `grep` / `findstr`. When a query is detected, it asks Code Memory for a small indexed context snippet and returns it as additional context.

Safety behavior:

- Uses the runtime selected by `setup --runtime`.
- Times out quickly.
- Fails silently.
- Truncates output.
- Sets a recursion guard.
- Can be disabled with `CODE_MEMORY_HOOK_DISABLED=1`.

