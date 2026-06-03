/**
 * code-memory status — Show index status
 */

import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, DATABASE_FILE } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('status');

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show the current index status')
    .option('--json', 'Output as JSON')
    .option('--staleness', 'Include index freshness and changed-file diagnostics')
    .action(async (options) => {
      try {
        await showStatus(options);
      } catch (err) {
        log.error('Failed to get status', err);
        process.exit(1);
      }
    });
}

interface StatusOptions {
  json?: boolean;
  staleness?: boolean;
}

async function showStatus(options: StatusOptions): Promise<void> {
  const projectPath = process.cwd();
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);

  if (!existsSync(dbPath)) {
    console.log('No index found. Run "code-memory setup --project ." for full AI onboarding, or "code-memory bootstrap --project ." for index-only setup.');
    return;
  }

  const { getDatabase, getDatabaseHealth } = await import('../../storage/database.js');

  try {
    await getDatabase(projectPath);
    const { getDatabaseSync } = await import('../../storage/database.js');
    const db = getDatabaseSync();

    const meta = new Map<string, string>();
    try {
      const result = db.exec('SELECT key, value FROM index_metadata');
      if (result.length > 0) {
        for (const row of result[0].values) {
          meta.set(String(row[0]), String(row[1]));
        }
      }
    } catch { /* no metadata yet */ }

    // Count rows
    const files = db.exec('SELECT COUNT(*) FROM files');
    const symbols = db.exec('SELECT COUNT(*) FROM symbols');
    const edges = db.exec('SELECT COUNT(*) FROM edges');
    const chunks = db.exec('SELECT COUNT(*) FROM chunks');
    const memories = db.exec('SELECT COUNT(*) FROM memories');
    const contextLedger = db.exec('SELECT COUNT(*) FROM context_ledger');

    const fileCount = files.length > 0 ? Number(files[0].values[0][0]) : 0;
    const symCount = symbols.length > 0 ? Number(symbols[0].values[0][0]) : 0;
    const edgeCount = edges.length > 0 ? Number(edges[0].values[0][0]) : 0;
    const chunkCount = chunks.length > 0 ? Number(chunks[0].values[0][0]) : 0;
    const memCount = memories.length > 0 ? Number(memories[0].values[0][0]) : 0;
    const contextLedgerCount = contextLedger.length > 0 ? Number(contextLedger[0].values[0][0]) : 0;

    if (options.json) {
      const embeddingProvider = meta.get('embedding_provider') || null;
      const vectorSearch = getVectorSearchStatus(meta);
      const health = getDatabaseHealth();
      const { getIndexStaleness } = await import('../../indexer/staleness.js');
      const staleness = getIndexStaleness(projectPath, db);
      console.log(JSON.stringify({
        project: meta.get('project_name') || 'Unknown',
        rootPath: meta.get('root_path') || null,
        languages: parseLanguages(meta.get('languages')),
        branch: meta.get('current_branch') || null,
        commit: meta.get('current_commit') || null,
        embeddingProvider,
        embeddingModel: meta.get('embedding_model') || null,
        vectorSearch,
        files: fileCount,
        symbols: symCount,
        edges: edgeCount,
        chunks: chunkCount,
        memories: memCount,
        contextLedgerEntries: contextLedgerCount,
        schemaVersion: health.schemaVersion,
        needsReindex: health.needsReindex,
        indexStatus: meta.get('index_status') || 'idle',
        indexRunId: meta.get('index_run_id') || null,
        indexRunMode: meta.get('index_run_mode') || null,
        indexStartedAt: meta.get('index_started_at') || null,
        indexCompletedAt: meta.get('index_completed_at') || null,
        lastIndexError: meta.get('last_index_error') || null,
        lastIndexDurationMs: Number(meta.get('last_index_duration_ms') || 0),
        lastIndexScanMs: Number(meta.get('last_index_scan_ms') || 0),
        lastIndexParseMs: Number(meta.get('last_index_parse_ms') || 0),
        lastIndexWriteMs: Number(meta.get('last_index_write_ms') || 0),
        lastIndexEdgeMs: Number(meta.get('last_index_edge_ms') || 0),
        lastIndexVectorMs: Number(meta.get('last_index_vector_ms') || 0),
        lastIndexCommunityMs: Number(meta.get('last_index_community_ms') || 0),
        lastIndexProcessMs: Number(meta.get('last_index_process_ms') || 0),
        lastIndexPeakRssMb: Number(meta.get('last_index_peak_rss_mb') || 0),
        parseWorkers: Number(meta.get('parse_workers') || 0),
        dirtyFiles: Number(meta.get('dirty_files') || 0),
        unresolvedCalls: Number(meta.get('unresolved_calls') || 0),
        lastIndex: meta.get('last_full_index') || meta.get('last_incremental_index') || null,
        ...(options.staleness ? { staleness } : {}),
      }, null, 2));
    } else {
      const health = getDatabaseHealth();
      console.log('Code Memory v0.2.0');
      console.log('');
      console.log(`Project:     ${meta.get('project_name') || 'Unknown'}`);
      console.log(`Root Path:   ${meta.get('root_path') || '(not set)'}`);
      console.log(`Languages:   ${parseLanguages(meta.get('languages')).join(', ') || '(not set)'}`);
      console.log(`Branch:      ${meta.get('current_branch') || '(not set)'}`);
      console.log(`Commit:      ${(meta.get('current_commit') || '').slice(0, 8) || '(not set)'}`);
      console.log(`Embedding:   ${meta.get('embedding_provider') || '(not set)'} (${meta.get('embedding_model') || '(not set)'})`);
      console.log(`Vector:      ${getVectorSearchStatus(meta).replace('_', ' ')}`);
      console.log(`Schema:      v${health.schemaVersion}${health.needsReindex ? ' (needs bootstrap --project .)' : ''}`);
      console.log(`Index State: ${meta.get('index_status') || 'idle'}`);
      console.log(`Last Index:  ${meta.get('last_full_index') || '(never)'}`);
      if (meta.get('last_index_error')) {
        console.log(`Last Error:  ${meta.get('last_index_error')}`);
      }
      console.log(`Duration:    ${Number(meta.get('last_index_duration_ms') || 0)} ms`);
      console.log(`Peak RSS:    ${Number(meta.get('last_index_peak_rss_mb') || 0)} MB`);
      console.log('');
      console.log(`Files:       ${fileCount}`);
      console.log(`Symbols:     ${symCount}`);
      console.log(`Edges:       ${edgeCount}`);
      console.log(`Chunks:      ${chunkCount}`);
      console.log(`Memories:    ${memCount}`);
      console.log(`Ledger:      ${contextLedgerCount} entries`);
      console.log(`Unresolved:  ${Number(meta.get('unresolved_calls') || 0)} calls`);
      if (options.staleness) {
        const { getIndexStaleness } = await import('../../indexer/staleness.js');
        const staleness = getIndexStaleness(projectPath, db);
        console.log('');
        console.log(`Freshness:   ${staleness.indexStatus}`);
        console.log(`Changed:     ${staleness.changedFiles} files`);
        console.log(`Watch Sync:  ${staleness.watchSyncStatus || '(unknown)'}`);
        console.log(`Watch Event: ${staleness.watchLastTriggerReason || '(unknown)'}`);
        console.log(`Watch Paths: ${staleness.watchLastChangedPaths.length} tracked`);
        console.log(`Pending:     ${staleness.watchPendingCount}`);
        if (staleness.watchLastSyncDurationMs !== null) {
          console.log(`Watch Time:  ${staleness.watchLastSyncDurationMs} ms`);
        }
        if (staleness.lastWatchError) {
          console.log(`Watch Error: ${staleness.lastWatchError}`);
          console.log(`Error Time:  ${staleness.lastWatchErrorAt || '(unknown)'}`);
        }
        if (staleness.recommendedAction) {
          console.log(`Action:      ${staleness.recommendedAction}`);
        }
      }
    }
  } catch (err) {
    log.error('Failed to read index', err);
    console.log('Error reading index. Try running "code-memory bootstrap --project ." first.');
  }
}

function parseLanguages(value: string | undefined): string[] {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function getVectorSearchStatus(meta: Map<string, string>): 'disabled' | 'pending_index' | 'enabled' {
  if (meta.get('vector_search') === 'enabled') return 'enabled';
  const embeddingProvider = meta.get('embedding_provider');
  return embeddingProvider && embeddingProvider !== 'none' ? 'pending_index' : 'disabled';
}
