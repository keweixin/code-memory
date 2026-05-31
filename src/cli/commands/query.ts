/**
 * code-memory query — Search the project index from CLI
 */

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('query');

export function registerQueryCommand(program: Command): void {
  program
    .command('query <question>')
    .description('Query the project index')
    .option('-l, --limit <number>', 'Max results', '10')
    .option('-m, --mode <mode>', 'Search mode: hybrid | keyword | graph', 'keyword')
    .option('--json', 'Output as JSON')
    .action(async (question, options) => {
      try {
        await queryIndex(question, options);
      } catch (err) {
        log.error('Query failed', err);
        process.exit(1);
      }
    });
}

interface QueryOptions {
  limit?: string;
  mode?: string;
  json?: boolean;
}

async function queryIndex(question: string, options: QueryOptions): Promise<void> {
  const projectPath = process.cwd();
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);

  try { readFileSync(configPath, 'utf-8'); }
  catch { console.error('No config found. Run "code-memory init" first.'); process.exit(1); }

  const { getDatabase } = await import('../../storage/database.js');
  const { HybridSearchEngine } = await import('../../search/hybrid-search.js');
  const { searchSymbolsFts, normalizeFts3Scores } = await import('../../search/fts-search.js');

  await getDatabase(projectPath);
  const { getDatabaseSync } = await import('../../storage/database.js');
  const db = getDatabaseSync();

  const limit = parseInt(options.limit || '10', 10);
  const results = normalizeFts3Scores(searchSymbolsFts(db, { query: question, limit }));

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`Results for "${question}" (${results.length}):\n`);
    for (const r of results) {
      console.log(`  ${r.name} (${r.kind}) — ${r.filePath}`);
      console.log(`    score: ${r.score.toFixed(3)}`);
      if (r.snippet) console.log(`    ${r.snippet}`);
      console.log();
    }
  }
}
