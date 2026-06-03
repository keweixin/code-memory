#!/usr/bin/env node

/**
 * Context Benchmark — Measures search quality metrics across different
 * retrieval modes (keyword_only, vector_only, graph_only, hybrid, hybrid_ledger).
 *
 * Workflow:
 *  1. Create a synthetic project with known structure
 *  2. Index it with code-memory CLI
 *  3. Load benchmark task definitions (task.json)
 *  4. For each task × mode, run a search query and compute metrics
 *  5. Output JSON with actual metric values
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, 'dist', 'index.js');

// ── CLI arg parsing ──────────────────────────────────────────

const options = parseArgs(process.argv.slice(2));
const taskFilter = String(options.task ?? 'all');
const modeFilter = String(options.mode ?? 'all');
const embedding = String(options.embedding ?? 'none');
const keepProject = Boolean(options.keep);

const VALID_MODES = ['keyword_only', 'vector_only', 'graph_only', 'hybrid', 'hybrid_ledger'];

// ── Main ─────────────────────────────────────────────────────

const tempRoot = join(tmpdir(), `code-memory-ctx-bench-${Date.now()}`);

try {
  // 1. Create and index the benchmark project
  createBenchmarkProject(tempRoot);
  await runCli(['init', '--embedding', embedding, '--languages', 'typescript', 'javascript'], tempRoot);
  const indexArgs = ['index', '--full'];
  const indexRun = await runCli(indexArgs, tempRoot);

  // 2. Load task definitions
  const tasks = loadTasks(repoRoot);
  const filteredTasks = taskFilter === 'all'
    ? tasks
    : tasks.filter((t) => t.name === taskFilter);

  if (filteredTasks.length === 0) {
    throw new Error(`No tasks found matching "${taskFilter}". Available: ${tasks.map((t) => t.name).join(', ')}`);
  }

  const modesToRun = modeFilter === 'all'
    ? VALID_MODES
    : VALID_MODES.filter((m) => m === modeFilter);

  if (modesToRun.length === 0) {
    throw new Error(`No modes found matching "${modeFilter}". Available: ${VALID_MODES.join(', ')}`);
  }

  // 3. Run benchmarks
  const allResults = [];

  for (const task of filteredTasks) {
    for (const mode of modesToRun) {
      // Skip vector_only if no embedding
      if (mode === 'vector_only' && embedding === 'none') continue;

      const result = await runBenchmark(task, mode, tempRoot);
      allResults.push(result);
    }
  }

  // 4. Output results
  const output = {
    benchmark: 'context',
    status: allResults.length > 0 ? 'complete' : 'skipped',
    projectRoot: tempRoot,
    embedding,
    taskCount: filteredTasks.length,
    modeCount: modesToRun.length,
    results: allResults,
    metrics: aggregateMetrics(allResults),
    primaryMetrics: aggregateMetrics(allResults.filter((result) =>
      result.mode === 'hybrid' || result.mode === 'hybrid_ledger',
    )),
  };

  console.log(JSON.stringify(output, null, 2));
} finally {
  if (keepProject) {
    console.error(`Benchmark project kept at ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// ── Task Loader ──────────────────────────────────────────────

function loadTasks(root) {
  const tasksDir = join(root, 'benchmark', 'tasks');
  const tasks = [];

  if (!existsSync(tasksDir)) {
    console.error(`Warning: No tasks directory at ${tasksDir}`);
    return tasks;
  }

  // Find all task.json files
  const taskDirs = listDirs(tasksDir);
  for (const dir of taskDirs) {
    const taskFile = join(dir, 'task.json');
    if (!existsSync(taskFile)) continue;

    try {
      const raw = readFileSync(taskFile, 'utf-8');
      const def = JSON.parse(raw);
      // Support both new schema (task, forbiddenWasteFiles, successCriteria)
      // and legacy schema (id, description, query, intent)
      tasks.push({
        name: basename(dir),
        task: def.task || def.query || '',
        expectedFiles: def.expectedFiles || [],
        expectedSymbols: def.expectedSymbols || [],
        forbiddenWasteFiles: def.forbiddenWasteFiles || [],
        successCriteria: def.successCriteria || {},
      });
    } catch (err) {
      console.error(`Warning: Failed to load task ${taskFile}: ${err.message}`);
    }
  }

  return tasks;
}

function listDirs(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) results.push(join(dir, entry.name));
    }
  } catch {
    // empty
  }
  return results;
}

// ── Benchmark Runner ─────────────────────────────────────────

async function runBenchmark(task, mode, projectDir) {
  const cliMode = mapModeToCli(mode);
  const sessionId = mode === 'hybrid_ledger' ? `bench-${task.name}-${Date.now()}` : undefined;

  // If hybrid_ledger, run two queries with the same session to test ledger
  let searchResults = [];
  let latencyMs = 0;

  if (mode === 'hybrid_ledger') {
    // First query to populate the ledger
    const firstStart = Date.now();
    const firstRun = await runCli(
      ['query', task.task, '--mode', 'hybrid', '--limit', '20', '--json'],
      projectDir,
    );
    latencyMs = Date.now() - firstStart;

    try {
      searchResults = parseQueryJson(firstRun.stdout);
    } catch {
      searchResults = [];
    }

    // Second query with same session to measure repeated context
    const secondStart = Date.now();
    const secondRun = await runCli(
      ['query', task.task, '--mode', 'hybrid', '--limit', '20', '--json'],
      projectDir,
    );
    const secondLatency = Date.now() - secondStart;
    latencyMs = Math.round((latencyMs + secondLatency) / 2);

    try {
      const secondResults = parseQueryJson(secondRun.stdout);
      // Merge and mark which are repeated
      searchResults = mergeWithRepetition(searchResults, secondResults);
    } catch {
      // Keep first results only
    }
  } else {
    const start = Date.now();
    const run = await runCli(
      ['query', task.task, '--mode', cliMode, '--limit', '20', '--json'],
      projectDir,
    );
    latencyMs = Date.now() - start;

    try {
      searchResults = parseQueryJson(run.stdout);
    } catch {
      searchResults = [];
    }
  }

  // Calculate metrics
  const metrics = calculateMetrics(task, searchResults, latencyMs, mode);

  return {
    task: task.name,
    mode,
    query: task.task,
    resultCount: searchResults.length,
    metrics,
  };
}

function mapModeToCli(mode) {
  switch (mode) {
    case 'keyword_only': return 'keyword';
    case 'vector_only': return 'vector';
    case 'graph_only': return 'graph';
    case 'hybrid':
    case 'hybrid_ledger':
      return 'hybrid';
    default: return 'hybrid';
  }
}

function parseQueryJson(stdout) {
  // The CLI may output non-JSON lines before the JSON; find the JSON start
  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) {
    // Try object format
    const objStart = stdout.indexOf('{');
    if (objStart === -1) return [];
    const obj = JSON.parse(stdout.slice(objStart));
    return Array.isArray(obj) ? obj : [obj];
  }
  return JSON.parse(stdout.slice(jsonStart));
}

function mergeWithRepetition(first, second) {
  const firstIds = new Set(first.map((r) => r.id));
  return second.map((r) => ({
    ...r,
    _repeated: firstIds.has(r.id),
  }));
}

// ── Metric Calculations ──────────────────────────────────────

function calculateMetrics(task, results, latencyMs, mode) {
  // keyFileRecall: fraction of expectedFiles found in results
  const resultFilePaths = new Set(results.map((r) => r.filePath || ''));
  const foundFiles = task.expectedFiles.filter((f) =>
    resultFilePaths.has(f) || [...resultFilePaths].some((p) => p.endsWith(f) || f.endsWith(basename(p))),
  );
  const keyFileRecall = task.expectedFiles.length > 0
    ? foundFiles.length / task.expectedFiles.length
    : 1;

  // evidenceCoverage: fraction of results that have evidence or snippet
  const withEvidence = results.filter((r) =>
    (r.evidence && r.evidence.length > 0) ||
    (r.snippet && r.snippet.length > 0) ||
    (r.sources && r.sources.length > 0),
  );
  const evidenceCoverage = results.length > 0
    ? withEvidence.length / results.length
    : 0;

  // repeatedContextRatio: fraction of repeated context (only for hybrid_ledger)
  let repeatedContextRatio = 0;
  if (mode === 'hybrid_ledger' && results.length > 0) {
    const repeated = results.filter((r) => r._repeated).length;
    repeatedContextRatio = repeated / results.length;
  }

  // tokenWasteRatio: fraction of tokens spent on forbidden waste files
  const wasteFiles = results.filter((r) =>
    task.forbiddenWasteFiles.some((pattern) => matchGlob(r.filePath || '', pattern)),
  );
  const totalTokens = results.reduce((sum, r) => {
    const snippet = r.snippet || '';
    return sum + estimateTokens(snippet);
  }, 0);
  const wasteTokens = wasteFiles.reduce((sum, r) => {
    const snippet = r.snippet || '';
    return sum + estimateTokens(snippet);
  }, 0);
  const tokenWasteRatio = totalTokens > 0 ? wasteTokens / totalTokens : 0;

  // searchLatencyMs: average search latency
  const searchLatencyMs = latencyMs;

  // Additional metrics
  const expectedSymbolNames = new Set(task.expectedSymbols);
  const foundSymbols = results.filter((r) => expectedSymbolNames.has(r.name));
  const symbolRecall = task.expectedSymbols.length > 0
    ? foundSymbols.length / task.expectedSymbols.length
    : 1;

  return {
    keyFileRecall: round3(keyFileRecall),
    evidenceCoverage: round3(evidenceCoverage),
    repeatedContextRatio: round3(repeatedContextRatio),
    tokenWasteRatio: round3(tokenWasteRatio),
    searchLatencyMs,
    symbolRecall: round3(symbolRecall),
    totalResultCount: results.length,
    wasteFileCount: wasteFiles.length,
  };
}

function matchGlob(filePath, pattern) {
  // Simple glob matching: * matches any chars
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(regexStr).test(filePath);
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// ── Aggregation ──────────────────────────────────────────────

function aggregateMetrics(results) {
  if (results.length === 0) {
    return {
      keyFileRecall: null,
      evidenceCoverage: null,
      repeatedContextRatio: null,
      tokenWasteRatio: null,
      searchLatencyMs: null,
      symbolRecall: null,
    };
  }

  const avg = (key) => {
    const vals = results.map((r) => r.metrics[key]).filter((v) => v != null);
    return vals.length > 0 ? round3(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  return {
    keyFileRecall: avg('keyFileRecall'),
    evidenceCoverage: avg('evidenceCoverage'),
    repeatedContextRatio: avg('repeatedContextRatio'),
    tokenWasteRatio: avg('tokenWasteRatio'),
    searchLatencyMs: avg('searchLatencyMs'),
    symbolRecall: avg('symbolRecall'),
  };
}

// ── Synthetic Project ────────────────────────────────────────

function createBenchmarkProject(root) {
  mkdirSync(join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(join(root, 'src', 'users'), { recursive: true });
  mkdirSync(join(root, 'src', 'middleware'), { recursive: true });
  mkdirSync(join(root, 'src', 'utils'), { recursive: true });
  mkdirSync(join(root, 'src', 'config'), { recursive: true });

  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'benchmark-context-project',
    type: 'module',
  }, null, 2));

  // ── Shared/module flow used by the generic benchmark tasks ──
  writeFileSync(join(root, 'src', 'shared.ts'), [
    'export interface Payload { id: string; email: string }',
    '',
    'export function normalizeEmail(email: string): string {',
    '  return email.trim().toLowerCase();',
    '}',
    '',
    'export function saveRecord(id: string): string {',
    '  return `saved:${id}`;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'src', 'module-0.ts'), [
    "import { normalizeEmail, saveRecord, type Payload } from './shared.js';",
    '',
    'export class Service0 {',
    '  validate(payload: Payload): boolean {',
    '    return normalizeEmail(payload.email).includes("@");',
    '  }',
    '',
    '  save(payload: Payload): string {',
    '    if (!this.validate(payload)) throw new Error("invalid payload");',
    '    return saveRecord(payload.id);',
    '  }',
    '}',
    '',
    'export function run0(payload: Payload): string {',
    '  const svc = new Service0();',
    '  return svc.save(payload);',
    '}',
    '',
  ].join('\n'));

  // ── Auth module ──
  writeFileSync(join(root, 'src', 'auth', 'auth-token.ts'), [
    "import { verifySignature, generateSecret } from '../utils/crypto.js';",
    "import { getConfig } from '../config/index.js';",
    '',
    'export interface AuthToken {',
    '  userId: string;',
    '  expiresAt: number;',
    '  scope: string[];',
    '  signature: string;',
    '}',
    '',
    'export function createAuthToken(userId: string, scope: string[] = []): AuthToken {',
    '  const config = getConfig();',
    '  const expiresAt = Date.now() + config.tokenTtlMs;',
    '  const signature = generateSecret(`${userId}:${expiresAt}`);',
    '  return { userId, expiresAt, scope, signature };',
    '}',
    '',
    'export function validateAuthToken(token: AuthToken): boolean {',
    '  if (Date.now() > token.expiresAt) return false;',
    '  const expected = generateSecret(`${token.userId}:${token.expiresAt}`);',
    '  return verifySignature(token.signature, expected);',
    '}',
    '',
    'export function refreshAuthToken(token: AuthToken): AuthToken | null {',
    '  if (!validateAuthToken(token)) return null;',
    '  return createAuthToken(token.userId, token.scope);',
    '}',
    '',
    'export function revokeAuthToken(token: AuthToken): void {',
    '  token.expiresAt = 0;',
    '  token.signature = "";',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'src', 'auth', 'auth-service.ts'), [
    "import { createAuthToken, validateAuthToken, refreshAuthToken, revokeAuthToken, type AuthToken } from './auth-token.js';",
    "import { findUserById, updateUserLastLogin } from '../users/user-service.js';",
    '',
    'export class AuthService {',
    '  private revokedTokens = new Set<string>();',
    '',
    '  async login(userId: string, password: string): Promise<AuthToken | null> {',
    '    const user = await findUserById(userId);',
    '    if (!user || user.passwordHash !== this.hashPassword(password)) return null;',
    '    const token = createAuthToken(userId, user.roles);',
    '    await updateUserLastLogin(userId);',
    '    return token;',
    '  }',
    '',
    '  async verify(token: AuthToken): Promise<boolean> {',
    '    if (this.revokedTokens.has(token.signature)) return false;',
    '    return validateAuthToken(token);',
    '  }',
    '',
    '  async refresh(token: AuthToken): Promise<AuthToken | null> {',
    '    if (this.revokedTokens.has(token.signature)) return null;',
    '    return refreshAuthToken(token);',
    '  }',
    '',
    '  async revoke(token: AuthToken): Promise<void> {',
    '    this.revokedTokens.add(token.signature);',
    '    revokeAuthToken(token);',
    '  }',
    '',
    '  private hashPassword(password: string): string {',
    '    // Simple hash for benchmark purposes',
    '    return password.split("").reverse().join("");',
    '  }',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'src', 'auth', 'index.ts'), [
    "export { AuthService } from './auth-service.js';",
    "export { createAuthToken, validateAuthToken, refreshAuthToken, revokeAuthToken, type AuthToken } from './auth-token.js';",
    '',
  ].join('\n'));

  // ── Users module ──
  writeFileSync(join(root, 'src', 'users', 'user-model.ts'), [
    'export interface User {',
    '  id: string;',
    '  email: string;',
    '  name: string;',
    '  roles: string[];',
    '  passwordHash: string;',
    '  lastLogin: number | null;',
    '  createdAt: number;',
    '  updatedAt: number;',
    '}',
    '',
    'export interface CreateUserDTO {',
    '  email: string;',
    '  name: string;',
    '  password: string;',
    '  roles?: string[];',
    '}',
    '',
    'export interface UpdateUserDTO {',
    '  email?: string;',
    '  name?: string;',
    '  roles?: string[];',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'src', 'users', 'user-repository.ts'), [
    "import type { User, CreateUserDTO, UpdateUserDTO } from './user-model.js';",
    '',
    'const users = new Map<string, User>();',
    '',
    'export function findUserById(id: string): User | undefined {',
    '  return users.get(id);',
    '}',
    '',
    'export function findUserByEmail(email: string): User | undefined {',
    '  return [...users.values()].find((u) => u.email === email);',
    '}',
    '',
    'export function createUser(dto: CreateUserDTO): User {',
    '  const user: User = {',
    '    id: crypto.randomUUID(),',
    '    email: dto.email,',
    '    name: dto.name,',
    '    roles: dto.roles || ["user"],',
    '    passwordHash: dto.password.split("").reverse().join(""),',
    '    lastLogin: null,',
    '    createdAt: Date.now(),',
    '    updatedAt: Date.now(),',
    '  };',
    '  users.set(user.id, user);',
    '  return user;',
    '}',
    '',
    'export function updateUser(id: string, dto: UpdateUserDTO): User | null {',
    '  const user = users.get(id);',
    '  if (!user) return null;',
    '  Object.assign(user, dto, { updatedAt: Date.now() });',
    '  return user;',
    '}',
    '',
    'export function deleteUser(id: string): boolean {',
    '  return users.delete(id);',
    '}',
    '',
    'export function listUsers(): User[] {',
    '  return [...users.values()];',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'src', 'users', 'user-service.ts'), [
    "import type { User, CreateUserDTO, UpdateUserDTO } from './user-model.js';",
    "import { findUserById, findUserByEmail, createUser, updateUser, deleteUser, listUsers } from './user-repository.js';",
    '',
    'export { findUserById, findUserByEmail, createUser, updateUser, deleteUser, listUsers };',
    '',
    'export async function updateUserLastLogin(userId: string): Promise<void> {',
    '  const user = findUserById(userId);',
    '  if (user) {',
    '    updateUser(userId, { name: user.name });',
    '  }',
    '}',
    '',
    'export function getUserProfile(userId: string): Omit<User, "passwordHash"> | null {',
    '  const user = findUserById(userId);',
    '  if (!user) return null;',
    '  const { passwordHash, ...profile } = user;',
    '  return profile;',
    '}',
    '',
    'export function registerUser(dto: CreateUserDTO): User | null {',
    '  const existing = findUserByEmail(dto.email);',
    '  if (existing) return null;',
    '  return createUser(dto);',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'src', 'users', 'index.ts'), [
    "export { findUserById, findUserByEmail, createUser, updateUser, deleteUser, listUsers, updateUserLastLogin, getUserProfile, registerUser } from './user-service.js';",
    "export type { User, CreateUserDTO, UpdateUserDTO } from './user-model.js';",
    '',
  ].join('\n'));

  // ── Middleware ──
  writeFileSync(join(root, 'src', 'middleware', 'auth-middleware.ts'), [
    "import { validateAuthToken, type AuthToken } from '../auth/auth-token.js';",
    '',
    'export interface RequestContext {',
    '  token: AuthToken | null;',
    '  userId: string | null;',
    '  path: string;',
    '  method: string;',
    '}',
    '',
    'export function authMiddleware(ctx: RequestContext): boolean {',
    '  if (!ctx.token) return false;',
    '  if (!validateAuthToken(ctx.token)) return false;',
    '  ctx.userId = ctx.token.userId;',
    '  return true;',
    '}',
    '',
    'export function requireScope(scope: string) {',
    '  return (ctx: RequestContext): boolean => {',
    '    if (!ctx.token) return false;',
    '    return ctx.token.scope.includes(scope);',
    '  };',
    '}',
    '',
  ].join('\n'));

  // ── Utils ──
  writeFileSync(join(root, 'src', 'utils', 'crypto.ts'), [
    'export function generateSecret(input: string): string {',
    '  return Buffer.from(input).toString("base64");',
    '}',
    '',
    'export function verifySignature(signature: string, expected: string): boolean {',
    '  return signature === expected;',
    '}',
    '',
    'export function hashPassword(password: string, salt: string): string {',
    '  return `${salt}:${password.split("").reverse().join("")}`;',
    '}',
    '',
  ].join('\n'));

  // ── Config ──
  writeFileSync(join(root, 'src', 'config', 'index.ts'), [
    'export interface AppConfig {',
    '  tokenTtlMs: number;',
    '  maxUsers: number;',
    '  enableRegistration: boolean;',
    '  databaseUrl: string;',
    '}',
    '',
    'const defaultConfig: AppConfig = {',
    '  tokenTtlMs: 3600000,',
    '  maxUsers: 1000,',
    '  enableRegistration: true,',
    '  databaseUrl: "memory://",',
    '};',
    '',
    'let currentConfig: AppConfig = { ...defaultConfig };',
    '',
    'export function getConfig(): AppConfig {',
    '  return currentConfig;',
    '}',
    '',
    'export function updateConfig(partial: Partial<AppConfig>): void {',
    '  currentConfig = { ...currentConfig, ...partial };',
    '}',
    '',
  ].join('\n'));

  // ── Noise / waste files that should not appear in focused results ──
  writeFileSync(join(root, 'src', 'utils', 'logger.ts'), [
    'export function logInfo(msg: string): void { console.log(`[INFO] ${msg}`); }',
    'export function logError(msg: string): void { console.error(`[ERROR] ${msg}`); }',
    'export function logDebug(msg: string): void { console.log(`[DEBUG] ${msg}`); }',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'src', 'utils', 'helpers.ts'), [
    'export function debounce(fn: Function, ms: number): Function {',
    '  let timer: any;',
    '  return (...args: any[]) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };',
    '}',
    'export function throttle(fn: Function, ms: number): Function {',
    '  let last = 0;',
    '  return (...args: any[]) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...args); } };',
    '}',
    '',
  ].join('\n'));
}

// ── CLI helpers ──────────────────────────────────────────────

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { reject(error); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`code-memory ${args.join(' ')} exited ${code}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
