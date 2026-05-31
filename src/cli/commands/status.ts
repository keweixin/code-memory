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
}

async function showStatus(options: StatusOptions): Promise<void> {
  const projectPath = process.cwd();
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);

  if (!existsSync(dbPath)) {
    console.log('No index found. Run "code-memory init" and "code-memory index" first.');
    return;
  }

  const { getDatabase } = await import('../../storage/database.js');

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

    const fileCount = files.length > 0 ? Number(files[0].values[0][0]) : 0;
    const symCount = symbols.length > 0 ? Number(symbols[0].values[0][0]) : 0;
    const edgeCount = edges.length > 0 ? Number(edges[0].values[0][0]) : 0;
    const chunkCount = chunks.length > 0 ? Number(chunks[0].values[0][0]) : 0;
    const memCount = memories.length > 0 ? Number(memories[0].values[0][0]) : 0;

    if (options.json) {
      const embeddingProvider = meta.get('embedding_provider') || null;
      console.log(JSON.stringify({
        project: meta.get('project_name') || 'Unknown',
        rootPath: meta.get('root_path') || null,
        languages: parseLanguages(meta.get('languages')),
        branch: meta.get('current_branch') || null,
        commit: meta.get('current_commit') || null,
        embeddingProvider,
        embeddingModel: meta.get('embedding_model') || null,
        vectorSearch: embeddingProvider && embeddingProvider !== 'none' ? 'not_wired' : 'disabled',
        files: fileCount,
        symbols: symCount,
        edges: edgeCount,
        chunks: chunkCount,
        memories: memCount,
        lastIndex: meta.get('last_full_index') || meta.get('last_incremental_index') || null,
      }, null, 2));
    } else {
      console.log('Code Memory Graph v0.1.0');
      console.log('');
      console.log(`Project:     ${meta.get('project_name') || 'Unknown'}`);
      console.log(`Root Path:   ${meta.get('root_path') || '(not set)'}`);
      console.log(`Languages:   ${parseLanguages(meta.get('languages')).join(', ') || '(not set)'}`);
      console.log(`Branch:      ${meta.get('current_branch') || '(not set)'}`);
      console.log(`Commit:      ${(meta.get('current_commit') || '').slice(0, 8) || '(not set)'}`);
      console.log(`Embedding:   ${meta.get('embedding_provider') || '(not set)'} (${meta.get('embedding_model') || '(not set)'})`);
      console.log(`Vector:      ${meta.get('embedding_provider') && meta.get('embedding_provider') !== 'none' ? 'not wired' : 'disabled'}`);
      console.log(`Last Index:  ${meta.get('last_full_index') || '(never)'}`);
      console.log('');
      console.log(`Files:       ${fileCount}`);
      console.log(`Symbols:     ${symCount}`);
      console.log(`Edges:       ${edgeCount}`);
      console.log(`Chunks:      ${chunkCount}`);
      console.log(`Memories:    ${memCount}`);
    }
  } catch (err) {
    log.error('Failed to read index', err);
    console.log('Error reading index. Try running "code-memory index" first.');
  }
}

function parseLanguages(value: string | undefined): string[] {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}
