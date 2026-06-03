---
name: "code-memory-bootstrap"
description: "Auto-bootstrap code-memory for any project. Invoke at the START of EVERY conversation to ensure the current project has code-memory indexed and ready before doing any codebase work."
---

# Code-Memory Bootstrap

**STOP. DO NOT CHECK IF CODE-MEMORY IS INSTALLED. DO NOT RUN npm install. DO NOT run require.resolve. DO NOT touch node_modules. This skill uses only `npx` — which auto-downloads everything.**

## Mandatory Steps (Follow EXACTLY, no deviation)

### Step 1: Check for index database

Run this SINGLE command and nothing else:

```powershell
Test-Path ".code-memory/index.db"
```

If it returns `True`, you are DONE. Skip to Step 3.

### Step 2: Bootstrap

If Step 1 returned `False`, run this single command:

```powershell
npx code-memory@latest bootstrap
```

That's it. One command. `bootstrap` handles init + index --full automatically.

Wait for `Bootstrap complete` in the output.

### Step 3: Done

Index is ready. Proceed with user's actual task using MCP tools.

## FORBIDDEN ACTIONS

You MUST NOT under any circumstances:
- Run `npm install -g code-memory`
- Run `node -e "require.resolve('code-memory')"`
- Check if code-memory is "installed" in any way
- Run `npx code-memory@latest init` or `npx code-memory@latest index` separately — use `bootstrap` instead
- Run anything other than `Test-Path` or `npx code-memory@latest bootstrap`
