# Release Checklist

Use this checklist before publishing a public Code Memory release.

- [ ] Update `package.json`, `package-lock.json`, and `src/shared/constants.ts`.
- [ ] Update `CHANGELOG.md`.
- [ ] Run `npm run release:gate`.
- [ ] Run `npx gitnexus analyze`.
- [ ] Run `npx gitnexus detect-changes --repo code-memory --scope all`.
- [ ] Run `codegraph sync . && codegraph status .`.
- [ ] Confirm `npm whoami --registry=https://registry.npmjs.org` locally, or configure repository secret `NPM_TOKEN`.
- [ ] Create a signed or annotated release tag matching `package.json`, for example `git tag v0.3.6`.
- [ ] Push tag and verify GitHub Actions are green.
- [ ] Confirm GitHub Release exists.
- [ ] Confirm npm latest: `npm view @keweixin/code-memory version`.
