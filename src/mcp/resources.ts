import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SqlJsDatabase } from '../storage/database.js';
import { readRegistry } from '../cli/registry.js';
import { SCHEMA_VERSION } from '../storage/schema.js';
import { createBootstrapProtocolResult } from './repo-router.js';
import { getIndexStaleness } from '../indexer/staleness.js';
import { DatabaseRouter, ProjectNotReadyError } from './database-router.js';

type ResourceVariables = Record<string, string | string[]>;

export function registerCodeMemoryResources(server: McpServer, db?: SqlJsDatabase): void {
  const router = new DatabaseRouter(db);

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

  registerRepoResource(server, router, 'code-memory-repo-context', 'code-memory://repo/{name}/context', 'text/markdown', readRepoContext);
  registerRepoResource(server, router, 'code-memory-repo-symbols', 'code-memory://repo/{name}/symbols', 'application/json', readRepoSymbols);
  registerRepoResource(server, router, 'code-memory-repo-flows', 'code-memory://repo/{name}/flows', 'application/json', readRepoFlows);
  registerRepoResource(server, router, 'code-memory-repo-schema', 'code-memory://repo/{name}/schema', 'text/markdown', readRepoSchema);
  registerRepoResource(server, router, 'code-memory-repo-staleness', 'code-memory://repo/{name}/staleness', 'application/json', readRepoStaleness);
  registerRepoResource(server, router, 'code-memory-repo-routes', 'code-memory://repo/{name}/routes', 'application/json', readRepoRoutes);
  registerRepoResource(server, router, 'code-memory-repo-tests', 'code-memory://repo/{name}/tests', 'application/json', readRepoTests);
  registerRepoResource(server, router, 'code-memory-repo-communities', 'code-memory://repo/{name}/communities', 'application/json', readRepoCommunities);
  registerRepoResource(server, router, 'code-memory-repo-memories', 'code-memory://repo/{name}/memories', 'application/json', readRepoMemories);
}

function registerRepoResource(
  server: McpServer,
  router: DatabaseRouter,
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
      const repoName = normalizeResourceRepoName(firstVariable(variables.name));
      let routed: ReturnType<DatabaseRouter['open']> | null = null;
      try {
        routed = router.open({ repo: repoName });
        return {
          contents: [{
            uri: uri.href,
            mimeType,
            text: reader(routed.db, routed.projectRoot),
          }],
        };
      } catch (err) {
        if (err instanceof ProjectNotReadyError) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: resourceFallbackMimeType(mimeType),
              text: formatUnavailableResource(err, mimeType),
            }],
          };
        }
        throw err;
      } finally {
        routed?.close();
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
    'resolve_project -> plan_context -> get_context_pack/search_code -> search_symbols -> find_definition/find_references -> impact_analysis -> get_related_tests -> mark_context_used/get_context_delta',
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

function readRepoStaleness(db: SqlJsDatabase, projectRoot: string): string {
  return JSON.stringify(getIndexStaleness(projectRoot, db), null, 2);
}

function readRepoRoutes(db: SqlJsDatabase): string {
  const rows = queryRows(
    db,
    `SELECT re.framework,
            re.http_method AS method,
            re.route_path AS path,
            f.path AS filePath,
            re.symbol_id AS handlerSymbolId
       FROM route_endpoints re
       LEFT JOIN files f ON f.id = re.file_id
      ORDER BY re.route_path ASC, re.http_method ASC
      LIMIT 500`,
  );
  return JSON.stringify({ routes: rows, truncated: rows.length >= 500 }, null, 2);
}

function readRepoTests(db: SqlJsDatabase): string {
  const rows = queryRows(
    db,
    `SELECT path, language, size, indexed_at AS indexedAt
       FROM files
      WHERE role = 'test'
      ORDER BY path ASC
      LIMIT 500`,
  );
  return JSON.stringify({ tests: rows, truncated: rows.length >= 500 }, null, 2);
}

function readRepoCommunities(db: SqlJsDatabase): string {
  const rows = queryRows(
    db,
    `SELECT name, cohesion, symbol_count AS symbolCount, keywords, top_entry_symbols AS topEntrySymbols
       FROM communities
      ORDER BY symbol_count DESC, name ASC
      LIMIT 250`,
  );
  return JSON.stringify({ communities: rows, truncated: rows.length >= 250 }, null, 2);
}

function readRepoMemories(db: SqlJsDatabase): string {
  const rows = queryRows(
    db,
    `SELECT id, type, content, scope, evidence, confidence, created_commit AS createdCommit,
            last_validated_commit AS lastValidatedCommit, updated_at AS updatedAt
       FROM memories
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 250`,
  );
  return JSON.stringify({ memories: rows, truncated: rows.length >= 250 }, null, 2);
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

function normalizeResourceRepoName(value: string | undefined): string | undefined {
  if (!value || value === 'current') return undefined;
  return value;
}

function resourceFallbackMimeType(mimeType: string): string {
  return mimeType === 'application/json' ? 'application/json' : 'text/markdown';
}

function formatUnavailableResource(err: ProjectNotReadyError, mimeType: string): string {
  const toolResult = createBootstrapProtocolResult(err.resolution);
  const text = toolResult.content.map((item) => item.text).join('\n\n');
  if (mimeType === 'application/json') {
    return JSON.stringify({
      error: err.resolution.status === 'unknown' ? 'project_not_resolved' : 'project_not_ready',
      resolution: err.resolution,
      message: text,
    }, null, 2);
  }
  return text;
}
