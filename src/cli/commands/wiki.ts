/**
 * code-memory wiki — Generate a structured wiki JSON for LLM consumption.
 */

import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  CONFIG_DIR,
  DATABASE_FILE,
} from '../../shared/constants.js';
import {
  closeDatabase,
  getDatabase,
  needsReindex,
  type SqlJsDatabase,
} from '../../storage/database.js';
import { createLogger } from '../../shared/logger.js';
import { resolveProjectPath } from '../project-path.js';

const log = createLogger('wiki');

export interface WikiRoute {
  framework: string;
  method: string;
  pattern: string;
  handler: string;
}

export interface WikiStep {
  step: number;
  name: string;
  file: string;
  line: number;
}

export interface WikiProcess {
  name: string;
  entryPoint: string;
  stepCount: number;
  steps: WikiStep[];
}

export interface WikiCommunity {
  name: string;
  cohesion: number;
  symbolCount: number;
  keywords: string[];
  topSymbols: string[];
}

export interface WikiExternalDependency {
  package: string;
  usageCount: number;
}

export interface WikiProject {
  name: string;
  summary: string;
  primaryLanguage: string;
  totalNodes: number;
  totalEdges: number;
}

export interface WikiJson {
  project: WikiProject;
  communities: WikiCommunity[];
  processes: WikiProcess[];
  routes: WikiRoute[];
  externalDependencies: WikiExternalDependency[];
}

export function registerWikiCommand(program: Command): void {
  program
    .command('wiki [path]')
    .description('Generate .code-memory/wiki.json for downstream LLM consumption')
    .option('--project <path>', 'Project root path (overrides positional path, cwd, and CODE_MEMORY_PROJECT env)')
    .action(async (path, options) => {
      try {
        await runWiki(path, options);
      } catch (err) {
        log.error('Wiki generation failed', err);
        process.exit(1);
      }
    });
}

export async function runWiki(pathArg?: string, options: { project?: string } = {}): Promise<void> {
  const projectRoot = resolveProjectPath(options, pathArg);

  const wikiDir = join(projectRoot, CONFIG_DIR);
  const wikiPath = join(wikiDir, 'wiki.json');
  const resolvedWikiPath = resolve(wikiPath);

  if (!resolvedWikiPath.startsWith(resolve(projectRoot))) {
    console.error('Error: Invalid path — output would be outside the project directory.');
    process.exit(1);
  }

  const dbPath = join(projectRoot, CONFIG_DIR, DATABASE_FILE);

  if (!existsSync(dbPath)) {
    console.error('Error: No code-memory index found at ' + dbPath + '. Run `code-memory setup --project .` or `code-memory bootstrap --project .` first.');
    process.exit(1);
  }

  // `getDatabase` sets the global database handle so `needsReindex()` can
  // inspect metadata + table presence correctly. We also rely on it to
  // create any tables that the project does not yet have.
  const db = await getDatabase(projectRoot);
  try {
    if (needsReindex()) {
      console.error('Error: Index is stale. Run `code-memory bootstrap --project .` first.');
      process.exit(1);
    }

    const wiki = await buildWikiJson(db, projectRoot);
    const outputDir = join(projectRoot, CONFIG_DIR);
    await mkdir(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'wiki.json');
    await writeFile(outputPath, JSON.stringify(wiki, null, 2) + '\n', 'utf-8');

    console.log('Wrote ' + outputPath);
    console.log('Next-step: Feed wiki.json to your LLM to generate final markdown.');
  } finally {
    await closeDatabase();
  }
}

export async function buildWikiJson(
  db: SqlJsDatabase,
  projectRoot: string,
): Promise<WikiJson> {
  const project = await buildProjectSection(db, projectRoot);
  const communities = buildCommunitiesSection(db);
  const processes = buildProcessesSection(db);
  const routes = buildRoutesSection(db);
  const externalDependencies = buildExternalDependenciesSection(db);

  return {
    project,
    communities,
    processes,
    routes,
    externalDependencies,
  };
}

async function readProjectSummary(
  db: SqlJsDatabase,
  projectRoot: string,
): Promise<string> {
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, 'utf-8');
      const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = JSON.parse(stripped) as { description?: unknown };
      if (parsed && typeof parsed.description === 'string' && parsed.description.trim().length > 0) {
        return parsed.description.trim();
      }
    } catch {
      // fall through
    }
  }

  try {
    const rows = db.all<{ keywords: string }>(
      'SELECT keywords FROM communities ORDER BY symbol_count DESC LIMIT 3',
    );
    const allKeywords: string[] = [];
    for (const row of rows) {
      allKeywords.push(...parseStringArray(row.keywords));
    }
    const topKeywords = allKeywords.slice(0, 3);
    if (topKeywords.length > 0) {
      return `Project with ${rows.length} communit${rows.length === 1 ? 'y' : 'ies'}: ${topKeywords.join(', ')}`;
    }
  } catch {
    // fall through
  }

  const fileCount = readCount(db, 'SELECT COUNT(*) AS count FROM files');
  const symbolCount = readCount(db, 'SELECT COUNT(*) AS count FROM symbols');
  return `A codebase with ${fileCount} file${fileCount === 1 ? '' : 's'} and ${symbolCount} symbol${symbolCount === 1 ? '' : 's'}`;
}

async function buildProjectSection(
  db: SqlJsDatabase,
  projectRoot: string,
): Promise<WikiProject> {
  const fileCount = readCount(db, 'SELECT COUNT(*) AS count FROM files');
  const symbolCount = readCount(db, 'SELECT COUNT(*) AS count FROM symbols');
  const edgeCount = readCount(db, 'SELECT COUNT(*) AS count FROM edges');
  const projectName = await readProjectName(db, projectRoot);
  const primaryLanguage = readPrimaryLanguage(db);
  const summary = await readProjectSummary(db, projectRoot);

  return {
    name: projectName,
    summary,
    primaryLanguage,
    totalNodes: fileCount + symbolCount,
    totalEdges: edgeCount,
  };
}

async function readProjectName(
  db: SqlJsDatabase,
  projectRoot: string,
): Promise<string> {
  const metaName = readMetadata(db, 'project_name');
  if (metaName) return metaName;

  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, 'utf-8');
      const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = JSON.parse(stripped) as { name?: unknown };
      if (parsed && typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
        return parsed.name;
      }
    } catch {
      // fall through to directory name
    }
  }

  return basename(projectRoot) || 'unknown-project';
}

function readPrimaryLanguage(db: SqlJsDatabase): string {
  try {
    const rows = db.all<{ language: string; count: number }>(
      `SELECT language, COUNT(*) AS count FROM files
       WHERE language IS NOT NULL AND language != 'unknown'
       GROUP BY language
       ORDER BY count DESC
       LIMIT 1`,
    );
    if (rows.length > 0 && rows[0]) return rows[0].language;
  } catch {
    // table may be missing
  }
  return 'unknown';
}

function buildCommunitiesSection(db: SqlJsDatabase): WikiCommunity[] {
  try {
    const rows = db.all<RawCommunityRow>(
      `SELECT id, name, cohesion, symbol_count, keywords, top_entry_symbols
       FROM communities
       ORDER BY symbol_count DESC, name ASC`,
    );
    return rows.map((row) => ({
      name: row.name,
      cohesion: Number(row.cohesion),
      symbolCount: Number(row.symbol_count),
      keywords: parseStringArray(row.keywords),
      topSymbols: parseStringArray(row.top_entry_symbols),
    }));
  } catch {
    return [];
  }
}

function buildProcessesSection(db: SqlJsDatabase): WikiProcess[] {
  let processes: RawProcessRow[];
  try {
    processes = db.all<RawProcessRow>(
      `SELECT id, name, entry_point, entry_kind, step_count
       FROM processes
       ORDER BY name ASC`,
    );
  } catch {
    return [];
  }

  return processes.map((proc) => {
    const steps = buildProcessSteps(db, proc.id);
    return {
      name: proc.name,
      entryPoint: proc.entry_point,
      stepCount: steps.length,
      steps,
    };
  });
}

function buildProcessSteps(db: SqlJsDatabase, processId: string): WikiStep[] {
  try {
    const steps = db.all<{ step: number; name: string; file: string | null; line: number | null }>(
      `SELECT ps.step,
              COALESCE(s.name, ps.label, '') AS name,
              f.path AS file,
              s.start_line AS line
       FROM process_steps ps
       LEFT JOIN symbols s ON ps.symbol_id = s.id
       LEFT JOIN files f ON ps.file_id = f.id
       WHERE ps.process_id = ?
       ORDER BY ps.step`,
      [processId],
    );

    return steps.map((s) => ({
      step: s.step,
      name: s.name || '',
      file: s.file ?? '',
      line: s.line ?? 0,
    }));
  } catch {
    return [];
  }
}

function buildRoutesSection(db: SqlJsDatabase): WikiRoute[] {
  let routes: RawRouteRow[];
  try {
    routes = db.all<RawRouteRow>(
      `SELECT re.framework, re.http_method, re.route_path, re.file_id
         FROM route_endpoints re
        ORDER BY re.route_path ASC, re.http_method ASC`,
    );
  } catch {
    return [];
  }

  return routes.map((route) => ({
    framework: route.framework,
    method: route.http_method,
    pattern: route.route_path,
    handler: readRouteHandler(db, route.file_id),
  }));
}

function readRouteHandler(db: SqlJsDatabase, fileId: string): string {
  if (!fileId) return '';
  try {
    const rows = db.all<{ exported_name: string }>(
      `SELECT exported_name FROM file_exports WHERE file_id = ? LIMIT 1`,
      [fileId],
    );
    return rows[0]?.exported_name ?? '';
  } catch {
    return '';
  }
}

function buildExternalDependenciesSection(db: SqlJsDatabase): WikiExternalDependency[] {
  let rows: RawDependencyRow[];
  try {
    rows = db.all<RawDependencyRow>(
      `SELECT source, COUNT(*) AS usage_count
         FROM file_imports
        GROUP BY source
        ORDER BY usage_count DESC, source ASC`,
    );
  } catch {
    return [];
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isExternalImport(row.source)) continue;
    const existing = counts.get(row.source) ?? 0;
    counts.set(row.source, existing + Number(row.usage_count));
  }

  return [...counts.entries()]
    .map(([pkg, usageCount]) => ({ package: pkg, usageCount }))
    .sort((a, b) => b.usageCount - a.usageCount || a.package.localeCompare(b.package));
}

function isExternalImport(source: string): boolean {
  if (!source) return false;
  if (source.startsWith('.')) return false;
  if (source.startsWith('/')) return false;
  if (!/^[A-Za-z]/.test(source)) return false;
  return true;
}

function readCount(db: SqlJsDatabase, sql: string): number {
  try {
    const row = db.get<{ count: number | null }>(sql);
    if (row && row.count !== null && row.count !== undefined) {
      return Number(row.count);
    }
  } catch {
    // ignore
  }
  return 0;
}

function readMetadata(db: SqlJsDatabase, key: string): string | null {
  try {
    const row = db.get<{ value: string }>(
      'SELECT value FROM index_metadata WHERE key = ?',
      [key],
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // fall through to comma split
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

interface RawCommunityRow {
  id: string;
  name: string;
  cohesion: number;
  symbol_count: number;
  keywords: string;
  top_entry_symbols: string;
}

interface RawProcessRow {
  id: string;
  name: string;
  entry_point: string;
  entry_kind: string;
  step_count: number;
}

interface RawRouteRow {
  framework: string;
  http_method: string;
  route_path: string;
  file_id: string;
}

interface RawDependencyRow {
  source: string;
  usage_count: number;
}
