# Development

Local checks:

```bash
npm install
npm run build
npm test
npm run lint
npm run pack:check
npm run test:smoke
```

Use local runtime when testing generated MCP config against the current checkout:

```bash
npm run build
node dist/index.js setup --agent cursor --project . --runtime local
```

