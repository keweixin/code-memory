# Release

Current source release target: `1.0.0`.

Release readiness checks:

```bash
npm run release:gate
```

`release:gate` runs lint, build, full tests, coverage, pack, smoke, official
npm audit, synthetic benchmark gate, and real-repo dry-run. The release
workflow calls this same local gate to avoid CI drift.

Version consistency is enforced by tests:

- `package.json`
- `package-lock.json`
- `src/shared/constants.ts`
- top `CHANGELOG.md` entry
- README command table vs registered CLI commands

Publishing is tag-driven:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The release workflow verifies the tag matches `package.json`, runs the full release gate, creates a GitHub Release, and publishes to npm only when repository secret `NPM_TOKEN` is configured.

Before telling users to rely on `npx -y @keweixin/code-memory@latest`, verify:

```bash
npm view @keweixin/code-memory version
```

It must report the release version.
