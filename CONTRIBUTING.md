# Contributing to Code Memory

Thank you for your interest in contributing to Code Memory! This document provides guidelines and instructions for contributing.

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

- Use the [Bug Report](https://github.com/keweixin/code-memory/issues/new?template=bug_report.yml) template.
- Include the Code Memory version (`code-memory --version`), Node.js version, and OS.
- Provide steps to reproduce, expected behavior, and actual behavior.
- Attach relevant logs or `code-memory doctor` output if applicable.

### Suggesting Features

- Use the [Feature Request](https://github.com/keweixin/code-memory/issues/new?template=feature_request.yml) template.
- Describe the problem you're trying to solve, not just the solution you want.
- Explain how it fits with Code Memory's local-first, MCP-first philosophy.

### Improving Documentation

- Fix typos, clarify confusing sections, or add missing examples.
- Documentation lives in `docs/` and in the README.

## Development Setup

### Prerequisites

- Node.js >= 20.0.0
- npm

### Install and Build

```bash
git clone https://github.com/keweixin/code-memory.git
cd code-memory
npm install
npm run build
```

### Run Tests

```bash
npm test
```

Run a single test file:

```bash
npx vitest run tests/some-file.test.ts
```

Run benchmarks:

```bash
npm run bench
```

### Lint

```bash
npm run lint
```

## Pull Request Process

1. **Fork** the repository and create your branch from `master`.
2. **Make changes** with clear, focused commits.
3. **Add tests** for any new functionality or bug fixes.
4. **Ensure all checks pass**: `npm run lint && npm run build && npm test`.
5. **Update documentation** if your change affects user-facing behavior.
6. **Open a Pull Request** using the PR template.

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add new MCP tool for X`
- `fix: resolve stale banner path on Windows`
- `perf: batch SQL operations in index-manager`
- `docs: update README with new CLI command`
- `test: add tests for community detector`
- `refactor: simplify BFS in process-tracer`
- `chore: update dependencies`

### Code Style

- TypeScript strict mode is enabled.
- Follow the existing code patterns in the repository.
- Run `npm run lint` before submitting — zero errors required.

## Architecture Overview

```
src/
  cli/          CLI commands (init, index, serve, watch, wiki, ...)
  mcp/          MCP server, tool registry, and 25 MCP tools
  parser/       Tree-sitter parsing, symbol/call/import extraction
  indexer/      Index manager, watch service, persistence
  graph/        Graph engine, process tracer, community detector
  search/       FTS, vector, hybrid search, context packer
  storage/      SQLite schema, repositories (symbols, edges, chunks, ...)
  memory/       Context ledger, memory manager
  scanner/      File discovery, language detection
  shared/       Types, constants, utilities
```

### Key Design Principles

- **Local-first**: All data stays in `.code-memory/` inside the project. No telemetry.
- **MCP-first**: Features are exposed as MCP tools for AI agents.
- **Evidence-backed**: Every context item includes evidence explaining why it was included.
- **Adaptive budget**: Output size adjusts based on indexed node count.

## Adding a New MCP Tool

1. Create `src/mcp/tools/your-tool.ts` implementing the tool logic.
2. Register it in `src/mcp/tool-registry.ts` with `withResponseTiming()` wrapper.
3. Add tests in `tests/your-tool.test.ts`.
4. Update the README MCP Tools section.
5. If the tool returns file references, add stale banner support via `attachStaleBanner`.

## Questions?

Feel free to open an issue with the `question` label or start a [Discussion](https://github.com/keweixin/code-memory/discussions).
