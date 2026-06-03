# Release

Current source release target: `0.3.8`.

Release readiness checks:

```bash
npm run lint
npm run build
npm test
npm run test:coverage
npm run pack:check
npm run test:smoke
npm run audit:official
npm run benchmark:index -- --files 2000 --workers auto --embedding none > benchmark-index.json
npm run benchmark:context > benchmark-context.json
npm run benchmark:agent > benchmark-agent.json
npm run benchmark:gate -- --index benchmark-index.json --context benchmark-context.json --agent benchmark-agent.json
```

Version consistency is enforced by tests:

- `package.json`
- `package-lock.json`
- `src/shared/constants.ts`
- top `CHANGELOG.md` entry
- README command table vs registered CLI commands

Publishing is tag-driven:

```bash
git tag v0.3.8
git push origin v0.3.8
```

The release workflow verifies the tag matches `package.json`, runs the full release gate, creates a GitHub Release, and publishes to npm only when repository secret `NPM_TOKEN` is configured.

Before telling users to rely on `npx -y @keweixin/code-memory@latest`, verify:

```bash
npm view @keweixin/code-memory version
```

It must report the release version.
