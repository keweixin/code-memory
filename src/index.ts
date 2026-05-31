#!/usr/bin/env node

/**
 * Code Memory Graph — CLI Entry Point
 *
 * AI Project Cognitive Engine
 * One scan → continuous incremental updates → multi-layer graph
 * AI queries via MCP/CLI → minimum tokens, maximum context
 */

import { createCli } from './cli/cli.js';

const program = createCli();
program.parse();
