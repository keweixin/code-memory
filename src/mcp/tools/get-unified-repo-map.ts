/**
 * MCP Tool: get_unified_repo_map
 *
 * Aggregates an overview of every registered repository: name, path,
 * primary language, indexed node count, last-indexed timestamp, top
 * three communities, and top three processes. Also derives
 * `crossRepoSuggestions` — external dependency package names that
 * appear in three or more repos — useful for cross-repo navigation.
 *
 * The tool does not build cross-repo edges (v1 scope); it only emits
 * informational signals that an agent can use to drill in with the
 * per-repo tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SqlJsDatabase } from "../../storage/database.js";
import { openExistingDatabase } from "../../storage/database.js";
import { readRegistry, type RegistryEntry } from "../../cli/registry.js";
import { createLogger } from "../../shared/logger.js";
import { safeJsonParse } from "../../shared/utils.js";
import { createStructuredToolResult, errorToolResult, formatStructuredToolResult } from "../tool-result.js";

const log = createLogger("mcp:get-unified-repo-map");

const TOP_COMMUNITIES = 3;
const TOP_PROCESSES = 3;
const CROSS_REPO_THRESHOLD = 3;

export function registerGetUnifiedRepoMapTool(
  server: McpServer,
  _db?: SqlJsDatabase,
): void {
  server.tool(
    "get_unified_repo_map",
    "Get an aggregated overview of all registered repositories, including their " +
    "top communities, top processes, and last-indexed timestamp. " +
    "Useful for navigating multi-repo projects.",
    {
      repos: z
        .array(z.string())
        .optional()
        .describe("Optional list of registered repo names to include. Default: all registered repos"),
    },
    async ({ repos }) => {
      try {
        const result = await buildUnifiedMap(repos);
        log.info(`Returned unified repo map (${result.display.length} chars)`);
        return {
          content: [{
            type: "text" as const,
            text: formatStructuredToolResult(createStructuredToolResult({
              status: "ready",
              project: {
                root: "",
                repoName: "global",
                dbPath: "",
              },
              freshness: {
                indexStatus: "fresh",
                changedFiles: [],
                recommendedAction: result.overviews.length > 0 ? "choose repo and call resolve_project" : "register_project",
              },
              data: result,
              display: result.display,
              nextAction: {
                tool: result.overviews.length > 0 ? "resolve_project" : "register_project",
                reason: result.overviews.length > 0
                  ? "Choose a repo from the unified map, then resolve it before task retrieval."
                  : "No repos are registered. Register or bootstrap a project first.",
              },
            })),
          }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        log.error(`Failed to get unified repo map: ${errorMsg}`);
        return {
          content: [{
            type: "text" as const,
            text: formatStructuredToolResult(errorToolResult(
              errorMsg,
              { repos: repos ?? [] },
              `Error: Failed to get unified repo map - ${errorMsg}`,
            )),
          }],
          isError: true,
        };
      }
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────

interface CommunitySummary {
  name: string;
  cohesion: number;
  symbolCount: number;
  keywords: string[];
}

interface ProcessSummary {
  name: string;
  stepCount: number;
}

interface RepoOverview {
  name: string;
  path: string;
  primaryLanguage: string;
  nodeCount: number;
  edgeCount: number;
  lastIndexed: string | null;
  communities: CommunitySummary[];
  processes: ProcessSummary[];
  externalDeps: Set<string>;
}

interface RepoOverviewData {
  name: string;
  path: string;
  primaryLanguage: string;
  nodeCount: number;
  edgeCount: number;
  lastIndexed: string | null;
  communities: CommunitySummary[];
  processes: ProcessSummary[];
  externalDeps: string[];
}

interface CrossRepoSuggestion {
  package: string;
  repoCount: number;
}

async function buildUnifiedMap(repos: string[] | undefined): Promise<{
  requestedRepos: string[];
  selectedCount: number;
  overviewCount: number;
  overviews: RepoOverviewData[];
  crossRepoSuggestions: CrossRepoSuggestion[];
  display: string;
}> {
  const registry = readRegistry();
  const selected = selectRepos(registry.repos, repos);

  if (selected.length === 0) {
    const display = "=== Unified Repository Map ===\n\n" +
      "No registered repositories found. Run `code-memory register` to add a repository, " +
      "or pass a `repos` filter that matches a registered name.\n\n" +
      "--- Cross-repo suggestions ---\n" +
      "  (no registered repos to aggregate)\n";
    return {
      requestedRepos: repos ?? [],
      selectedCount: 0,
      overviewCount: 0,
      overviews: [],
      crossRepoSuggestions: [],
      display,
    };
  }

  // Use Promise.all to allow concurrent repo overview loading.
  // Currently sync (better-sqlite3), but structured for future async DB drivers.
  const overviews = (await Promise.all(
    selected.map((entry) => Promise.resolve(loadRepoOverview(entry)))
  )).filter((o): o is RepoOverview => o !== null);

  const crossRepoSuggestions = aggregateCrossRepoSuggestions(overviews);
  const overviewData = overviews.map((overview) => ({
    ...overview,
    externalDeps: [...overview.externalDeps].sort((a, b) => a.localeCompare(b)),
  }));

  return {
    requestedRepos: repos ?? [],
    selectedCount: selected.length,
    overviewCount: overviewData.length,
    overviews: overviewData,
    crossRepoSuggestions,
    display: formatUnifiedMap(overviews, crossRepoSuggestions),
  };
}

function selectRepos(all: RegistryEntry[], filter: string[] | undefined): RegistryEntry[] {
  if (!filter || filter.length === 0) return all;
  const lowered = filter.map((r) => r.toLowerCase());
  return all.filter((repo) =>
    lowered.some((token) => repo.name.toLowerCase().includes(token)),
  );
}

function loadRepoOverview(repo: RegistryEntry): RepoOverview | null {
  let db: SqlJsDatabase | null = null;
  try {
    db = openExistingDatabase(repo.rootPath);
  } catch (err) {
    log.warn(`Skipping ${repo.name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  try {
    const primaryLanguage = getPrimaryLanguage(db);
    const nodeCount = countNodes(db);
    const edgeCount = countEdges(db);
    const lastIndexed = getLastFullIndex(db);
    const communities = getTopCommunities(db, TOP_COMMUNITIES);
    const processes = getTopProcesses(db, TOP_PROCESSES);
    const externalDeps = getExternalDependencies(db);

    return {
      name: repo.name,
      path: repo.rootPath,
      primaryLanguage,
      nodeCount,
      edgeCount,
      lastIndexed,
      communities,
      processes,
      externalDeps,
    };
  } finally {
    db.close();
  }
}

function getPrimaryLanguage(db: SqlJsDatabase): string {
  try {
    const rows = db.all<{ language: string; count: number }>(
      `SELECT language, COUNT(*) AS count
       FROM files
       WHERE is_ignored = 0
       GROUP BY language
       ORDER BY count DESC
       LIMIT 1`,
    );
    return rows[0]?.language ?? "unknown";
  } catch {
    return "unknown";
  }
}

function countNodes(db: SqlJsDatabase): number {
  try {
    const files = db.get<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM files WHERE is_ignored = 0`);
    const symbols = db.get<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM symbols`);
    return (files?.cnt ?? 0) + (symbols?.cnt ?? 0);
  } catch {
    return 0;
  }
}

function countEdges(db: SqlJsDatabase): number {
  try {
    const row = db.get<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM edges`);
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function getLastFullIndex(db: SqlJsDatabase): string | null {
  try {
    const row = db.get<{ value: string }>(
      `SELECT value FROM index_metadata WHERE key = 'last_full_index'`,
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function getTopCommunities(db: SqlJsDatabase, limit: number): CommunitySummary[] {
  try {
    const rows = db.all<{
      name: string;
      cohesion: number;
      symbol_count: number;
      keywords: string;
    }>(
      `SELECT name, cohesion, symbol_count, keywords
       FROM communities
       ORDER BY symbol_count DESC, name ASC
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      name: row.name,
      cohesion: Number(row.cohesion ?? 0),
      symbolCount: Number(row.symbol_count ?? 0),
      keywords: parseStringList(row.keywords).slice(0, 3),
    }));
  } catch {
    return [];
  }
}

function getTopProcesses(db: SqlJsDatabase, limit: number): ProcessSummary[] {
  try {
    const rows = db.all<{ name: string; step_count: number }>(
      `SELECT name, step_count
       FROM processes
       ORDER BY step_count DESC, name ASC
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      name: row.name,
      stepCount: Number(row.step_count ?? 0),
    }));
  } catch {
    return [];
  }
}

function getExternalDependencies(db: SqlJsDatabase): Set<string> {
  const deps = new Set<string>();
  try {
    const rows = db.all<{ source: string }>(
      `SELECT DISTINCT source FROM file_imports WHERE source IS NOT NULL AND source != ''`,
    );
    for (const row of rows) {
      const pkg = extractPackageName(row.source);
      if (pkg) deps.add(pkg);
    }
  } catch {
    // file_imports may not exist on legacy indexes
  }
  return deps;
}

function extractPackageName(source: string): string | null {
  if (!source) return null;
  if (source.startsWith(".") || source.startsWith("/")) return null;
  if (source.startsWith("@")) {
    const parts = source.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  const head = source.split("/")[0] ?? source;
  return head || null;
}

function aggregateCrossRepoSuggestions(overviews: RepoOverview[]): CrossRepoSuggestion[] {
  if (overviews.length === 0) return [];
  const counts = new Map<string, Set<string>>();
  for (const overview of overviews) {
    for (const dep of overview.externalDeps) {
      const set = counts.get(dep) ?? new Set<string>();
      set.add(overview.name);
      counts.set(dep, set);
    }
  }
  const suggestions: CrossRepoSuggestion[] = [];
  for (const [pkg, repos] of counts) {
    if (repos.size >= CROSS_REPO_THRESHOLD) {
      suggestions.push({ package: pkg, repoCount: repos.size });
    }
  }
  suggestions.sort((a, b) => {
    if (a.repoCount !== b.repoCount) return b.repoCount - a.repoCount;
    return a.package.localeCompare(b.package);
  });
  return suggestions;
}

function formatUnifiedMap(
  overviews: RepoOverview[],
  crossRepoSuggestions: CrossRepoSuggestion[],
): string {
  const lines: string[] = [];
  lines.push("=== Unified Repository Map ===");
  lines.push("");

  for (const overview of overviews) {
    lines.push(`Repository: ${overview.name} (${overview.path})`);
    lines.push(`  Language: ${overview.primaryLanguage}`);
    lines.push(`  Indexed: ${overview.nodeCount} nodes, ${overview.edgeCount} edges`);
    lines.push(`  Last indexed: ${overview.lastIndexed ?? "(never)"}`);

    if (overview.communities.length > 0) {
      lines.push("  Top communities:");
      overview.communities.forEach((community, index) => {
        const keywordStr = community.keywords.length > 0
          ? ` — ${community.keywords.join(", ")}`
          : "";
        lines.push(
          `    ${index + 1}. ${community.name} ` +
            `(cohesion ${community.cohesion.toFixed(2)}, ${community.symbolCount} symbols)` +
            keywordStr,
        );
      });
    } else {
      lines.push("  Top communities: (none indexed — run `code-memory index` to build communities)");
    }

    if (overview.processes.length > 0) {
      lines.push("  Top processes:");
      overview.processes.forEach((process, index) => {
        lines.push(`    ${index + 1}. ${process.name} (${process.stepCount} steps)`);
      });
    } else {
      lines.push("  Top processes: (none indexed — run `code-memory index` to build processes)");
    }

    lines.push("");
  }

  lines.push("--- Cross-repo suggestions ---");
  if (crossRepoSuggestions.length === 0) {
    lines.push("  (no shared external dependencies across 3+ repos)");
  } else {
    for (const suggestion of crossRepoSuggestions) {
      lines.push(`  - ${suggestion.package} (${suggestion.repoCount} repos)`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function parseStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = safeJsonParse<unknown>(value);
  if (Array.isArray(parsed)) {
    return parsed.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}
