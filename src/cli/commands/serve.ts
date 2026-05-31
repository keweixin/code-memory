/**
 * code-memory serve — Start the MCP Server
 */

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('serve');

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the MCP server for AI tool integration')
    .option('--mcp', 'Use MCP stdio transport (default)', true)
    .action(async (options) => {
      try {
        await startServer(options);
      } catch (err) {
        log.error('Server failed to start', err);
        process.exit(1);
      }
    });
}

interface ServeOptions {
  mcp?: boolean;
}

async function startServer(_options: ServeOptions): Promise<void> {
  const projectPath = process.cwd();
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);

  // Verify config exists
  try {
    readFileSync(configPath, 'utf-8');
  } catch {
    log.error('No config found. Run "code-memory init" first.');
    process.exit(1);
  }

  // Set grammar path
  process.env.CODE_MEMORY_GRAMMARS = process.env.CODE_MEMORY_GRAMMARS || '/c/Users/ASUS/code-memory/grammars';

  log.info('Starting MCP server...');

  const { startServer: startMcp } = await import('../../mcp/server.js');
  await startMcp(projectPath);
}
