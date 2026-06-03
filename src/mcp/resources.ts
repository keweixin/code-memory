import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SqlJsDatabase } from '../storage/database.js';
import { readRegistry } from '../cli/registry.js';
import { SCHEMA_VERSION } from '../storage/schema.js';
import { openRoutedDatabase } from './repo-router.js';

type ResourceVariables = Record<string, string | string[]>;

export function registerCodeMemoryResources(server: McpServer, db: SqlJsDatabase): void {
  server.registerResource(
    'code-memory-repos',
    'code-memory://repos',
    {
      title: 'Code Memory registered repositories',
      description: 'Global entrypoint listing repositories registered with code-memory.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(readRegistry(), null, 2),
      }],
    }),
  );

  registerRepoResource(server, db, 'code-memory-repo-context', 'code-memory://repo/{name}/context', 'text/markdown', readRepoContext);
  registerRepoResource(server, db, 'code-memory-repo-symbols', 'code-memory://repo/{name}/symbols', 'application/json', readRepoSymbols);
  registerRepoResource(server, db, 'code-memory-repo-flows', 'code-memory://repo/{name}/flows', 'application/json', readRepoFlows);
  registerRepoResource(server, db, 'code-memory-repo-schema', 'code-memory://repo/{name}/schema', 'text/markdown', readRepoSchema);
}

function registerRepoResource(
  server: McpServer,
  db: SqlJsDatabase,
  name: string,
  template: string,
  mimeType: string,
  reader: (db: SqlJsDatabase, projectRoot: string) => string,
): void {
  server.registerResource(
    name,
    new ResourceTemplate(template, { list: undefined }),
    {
      title: name,
      description: 'Read-only Code Memory project map resource. Use this before broad code exploration.',
      mimeType,
    },
    async (uri, variables: ResourceVariables) => {
      const repoName = firstVariable(variables.name);
      const routed = openRoutedDatabase(repoName, db);
      try {
        return {
          contents: [{
            uri: uri.href,
            mimeType,
            text: reader(routed.db, routed.projectRoot),
          }],
        };
      } finally {
        routed.close();
      }
    },
  );
}

function readRepoContext(db: SqlJsDatabase, projectRoot: string): string {
  const metadata = readMetadata(db);
  const counts = readCounts(db);
  const languages = queryRows(db, 'SELECT language, COUNT(*) AS count FROM files GROUP BY language ORDER BY count DESC LIMIT 12');
  const communities = queryRows(db, 'SELECT name, symbol_count, cohesion, keywords FROM communities ORDER BY symbol_count DESC LIMIT 10');
  return [
    '# Code Memory Repo Context',
    '',
    '- Project root: ' + projectRoot,
    '- Schema version: ' + SCHEMA_VERSION,
    '- Current commit: ' + (metadata.current_commit || '(unknown)'),
    '- Index completed: ' + (metadata.index_completed || '(unknown)'),
    '- Files: ' + counts.files,
    '- Symbols: ' + counts.symbols,
    '- Edges: ' + counts.edges,
    '- Processes: ' + counts.processes,
    '',
    '## Recommended Workflow',
    '',
    'plan_context -> get_context_pack/search_code -> search_symbols/find_definition -> impact_analysis -> get_related_tests',
    '',
    '## Languages',
    '',
    JSON.stringify(languages, null, 2),
    '',
    '## Top Communities',
    '',
    JSON.stringify(communities, null, 2),
  ].join('\n');
}

function readRepoSymbols(db: SqlJsDatabase): string {
  const rows = queryRows(
    db,
    `SELECT s.name, s.kind, f.path AS filePath, s.start_line AS line, s.signature
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     ORDER BY f.path, s.start_line
     LIMIT 500`,
  );
  return JSON.stringify({ symbols: rows, truncated: rows.length >= 500 }, null, 2);
}

function readRepoFlows(db: SqlJsDatabase): string {
  const rows = queryRows(
    db,
    `SELECT name, entry_point AS entryPoint, entry_kind AS entryKind, framework, step_count AS stepCount, last_indexed AS lastIndexed
     FROM processes
     ORDER BY step_count DESC, name
     LIMIT 250`,
  );
  return JSON.stringify({ flows: rows, truncated: rows.length >= 250 }, null, 2);
}

function readRepoSchema(db: SqlJsDatabase, projectRoot: string): string {
  const tables = queryRows(
    db,
    `SELECT name, type
     FROM sqlite_master
     WHERE type IN ('table', 'view')
     ORDER BY name`,
  );
  return [
    '# Code Memory Schema',
    '',
    '- Project root: ' + projectRoot,
    '- Schema version: ' + SCHEMA_VERSION,
    '',
    '## Core Tables',
    '',
    JSON.stringify(tables, null, 2),
    '',
    '## Query Guidance',
    '',
    '- Use MCP tools for normal workflows; resources are project maps.',
    '- Prefer `impact_analysis` before editing code discovered through these resources.',
  ].join('\n');
}

function readMetadata(db: SqlJsDatabase): Record<string, string> {
  const rows = queryRows(db, 'SELECT key, value FROM index_metadata');
  const metadata: Record<string, string> = {};
  for (const row of rows) metadata[String(row.key)] = String(row.value);
  return metadata;
}

function readCounts(db: SqlJsDatabase): Record<string, number> {
  return {
    files: countRows(db, 'files'),
    symbols: countRows(db, 'symbols'),
    edges: countRows(db, 'edges'),
    processes: countRows(db, 'processes'),
  };
}

function countRows(db: SqlJsDatabase, table: string): number {
  const result = db.get<{ count?: number }>('SELECT COUNT(*) AS count FROM ' + table);
  return Number(result?.count ?? 0);
}

function queryRows(db: SqlJsDatabase, sql: string): Array<Record<string, unknown>> {
  return db.all(sql);
}

function firstVariable(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
