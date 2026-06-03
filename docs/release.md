# Release

Release readiness checks:

```bash
npm run lint
npm run build
npm test
npm run test:coverage
npm run pack:check
npm run test:smoke
npm run audit:official
npm run benchmark:index -- --files 2000 --workers auto --embedding none
```

The package should support real `npx` usage through the published npm package and packed tarball smoke tests before a v1.0 release.

