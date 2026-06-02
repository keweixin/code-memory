import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SqlJsDatabase } from '../storage/database.js';
import { getDbFilePath } from '../storage/database.js';
import { SCHEMA_VERSION } from '../storage/schema.js';
import { getIndexStaleness, type IndexStaleness } from '../indexer/staleness.js';
import { getRepoArgument, openRoutedDatabase } from './repo-router.js';

export interface McpIndexDiagnostics extends IndexStaleness {
  schemaVersion: number;
}

export function getMcpIndexDiagnostics(db: SqlJsDatabase, projectRoot?: string): McpIndexDiagnostics {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...getIndexStaleness(projectRoot || getProjectRootFromDbPath(), db),
  };
}

export function formatIndexDiagnostics(db: SqlJsDatabase, projectRoot?: string): string {
  const diagnostics = getMcpIndexDiagnostics(db, projectRoot);
  const lines = [
    '=== Index Diagnostics ===',
    'Index status: ' + diagnostics.indexStatus,
    'Schema: v' + diagnostics.schemaVersion,
    'Changed files: ' + diagnostics.changedFiles,
    'Last indexed: ' + (diagnostics.lastIndexedAt || '(unknown)'),
    'Last indexed commit: ' + (diagnostics.lastIndexedCommit || '(unknown)'),
    'Current commit: ' + (diagnostics.currentCommit || '(unknown)'),
    'Watch sync: ' + (diagnostics.watchSyncStatus || '(unknown)'),
    'Watch trigger: ' + (diagnostics.watchLastTriggerReason || '(unknown)'),
    'Watch changed paths: ' + diagnostics.watchLastChangedPaths.length,
    'Watch pending count: ' + diagnostics.watchPendingCount,
    'Watch sync duration: ' + (diagnostics.watchLastSyncDurationMs === null ? '(unknown)' : diagnostics.watchLastSyncDurationMs + ' ms'),
    'Last watch error: ' + (diagnostics.lastWatchError || '(none)'),
    'Last watch error at: ' + (diagnostics.lastWatchErrorAt || '(unknown)'),
    'Recommended action: ' + (diagnostics.recommendedAction || '(none)'),
  ];

  return lines.join('\n');
}

export function prependIndexDiagnostics(text: string, db: SqlJsDatabase, projectRoot?: string): string {
  if (text.startsWith('=== Index Diagnostics ===')) return text;
  return formatIndexDiagnostics(db, projectRoot) + '\n\n' + text;
}

export function withIndexDiagnostics(server: McpServer, db: SqlJsDatabase): McpServer {
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const diagnosticServer = Object.create(server) as McpServer;

  (diagnosticServer as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const maybeHandler = args[args.length - 1];
    if (typeof maybeHandler !== 'function') {
      return originalTool(...args);
    }

    const wrappedHandler = async (...handlerArgs: unknown[]) => {
      const result = await (maybeHandler as (...handlerArgs: unknown[]) => Promise<unknown> | unknown)(...handlerArgs);
      const repo = getRepoArgument(handlerArgs[0]);
      let routed: ReturnType<typeof openRoutedDatabase> | null = null;
      try {
        routed = openRoutedDatabase(repo, db);
        return addIndexDiagnosticsToToolResult(result, routed.db, routed.projectRoot);
      } catch {
        return addIndexDiagnosticsToToolResult(result, db);
      } finally {
        routed?.close();
      }
    };

    return originalTool(...args.slice(0, -1), wrappedHandler);
  };

  return diagnosticServer;
}

function addIndexDiagnosticsToToolResult(result: unknown, db: SqlJsDatabase, projectRoot?: string): unknown {
  if (!isToolResult(result)) return result;

  return {
    ...result,
    content: result.content.map((item) => {
      if (!isTextContent(item)) return item;
      return {
        ...item,
        text: prependIndexDiagnostics(item.text, db, projectRoot),
      };
    }),
  };
}

function isToolResult(value: unknown): value is { content: unknown[] } {
  return typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content);
}

function isTextContent(value: unknown): value is { type: 'text'; text: string } {
  return typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string';
}

function getProjectRootFromDbPath(): string {
  const dbPath = getDbFilePath();
  if (!dbPath) return process.cwd();
  return dirname(dirname(dbPath));
}
