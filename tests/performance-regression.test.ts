import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabase, getDatabaseSync } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';
import { upsertEdges } from '../src/storage/edge-repository.js';
import { upsertChunks } from '../src/storage/chunk-repository.js';
import { deleteChunksByFileId } from '../src/storage/chunk-repository.js';
import { deleteEdgesByNodeId } from '../src/storage/edge-repository.js';
import { generateId } from '../src/shared/utils.js';
import type { EdgeRecord, ChunkRecord } from '../src/shared/types.js';

// ── Helpers ─────────────────────────────────────────────────

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'perf-regression',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript'],
    embedding: {
      provider: 'none',
      model: 'none',
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

function writeConfig(rootPath: string, config: CodeMemoryConfig): void {
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(
    join(rootPath, '.code-memory', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

/**
 * Create a small synthetic TypeScript project with 15 files.
 */
function createTestProject(rootPath: string): void {
  const srcDir = join(rootPath, 'src');
  mkdirSync(srcDir, { recursive: true });

  // Shared types
  writeFileSync(
    join(srcDir, 'types.ts'),
    [
      'export interface User { id: string; name: string; email: string; }',
      'export interface Product { id: string; title: string; price: number; }',
      'export interface Order { id: string; userId: string; items: string[]; total: number; }',
    ].join('\n'),
    'utf-8',
  );

  // Utility functions
  writeFileSync(
    join(srcDir, 'utils.ts'),
    [
      'export function formatDate(d: Date): string { return d.toISOString(); }',
      'export function generateUUID(): string { return Math.random().toString(36).slice(2); }',
      'export function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(value, min), max); }',
    ].join('\n'),
    'utf-8',
  );

  // Logger
  writeFileSync(
    join(srcDir, 'logger.ts'),
    [
      'export class Logger {',
      '  info(msg: string): void { console.log(`[INFO] ${msg}`); }',
      '  error(msg: string): void { console.error(`[ERROR] ${msg}`); }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Database
  writeFileSync(
    join(srcDir, 'database.ts'),
    [
      "import { Logger } from './logger.js';",
      'export class Database {',
      '  private logger = new Logger();',
      '  connect(): void { this.logger.info("Connected"); }',
      '  disconnect(): void { this.logger.info("Disconnected"); }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // User repository
  writeFileSync(
    join(srcDir, 'user-repository.ts'),
    [
      "import { Database } from './database.js';",
      "import { User } from './types.js';",
      'export class UserRepository {',
      '  constructor(private db: Database) {}',
      '  findById(id: string): User | null { return null; }',
      '  findByEmail(email: string): User | null { return null; }',
      '  save(user: User): void {}',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Product repository
  writeFileSync(
    join(srcDir, 'product-repository.ts'),
    [
      "import { Database } from './database.js';",
      "import { Product } from './types.js';",
      'export class ProductRepository {',
      '  constructor(private db: Database) {}',
      '  findById(id: string): Product | null { return null; }',
      '  search(query: string): Product[] { return []; }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Order repository
  writeFileSync(
    join(srcDir, 'order-repository.ts'),
    [
      "import { Database } from './database.js';",
      "import { Order } from './types.js';",
      'export class OrderRepository {',
      '  constructor(private db: Database) {}',
      '  findByUserId(userId: string): Order[] { return []; }',
      '  create(order: Order): void {}',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Auth service
  writeFileSync(
    join(srcDir, 'auth-service.ts'),
    [
      "import { UserRepository } from './user-repository.js';",
      "import { Logger } from './logger.js';",
      "import { generateUUID } from './utils.js';",
      'export class AuthService {',
      '  private logger = new Logger();',
      '  constructor(private userRepo: UserRepository) {}',
      '  login(email: string, password: string): string | null {',
      '    const user = this.userRepo.findByEmail(email);',
      '    if (!user) { this.logger.error("User not found"); return null; }',
      '    return generateUUID();',
      '  }',
      '  logout(token: string): void { this.logger.info("Logged out"); }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Product service
  writeFileSync(
    join(srcDir, 'product-service.ts'),
    [
      "import { ProductRepository } from './product-repository.js';",
      "import { Logger } from './logger.js';",
      'export class ProductService {',
      '  private logger = new Logger();',
      '  constructor(private productRepo: ProductRepository) {}',
      '  search(query: string) {',
      '    this.logger.info(`Searching: ${query}`);',
      '    return this.productRepo.search(query);',
      '  }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Order service
  writeFileSync(
    join(srcDir, 'order-service.ts'),
    [
      "import { OrderRepository } from './order-repository.js';",
      "import { ProductRepository } from './product-repository.js';",
      "import { Logger } from './logger.js';",
      'export class OrderService {',
      '  private logger = new Logger();',
      '  constructor(private orderRepo: OrderRepository, private productRepo: ProductRepository) {}',
      '  placeOrder(userId: string, productIds: string[]) {',
      '    this.logger.info("Placing order");',
      '    return this.orderRepo.create({ id: "1", userId, items: productIds, total: 0 });',
      '  }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Notification service
  writeFileSync(
    join(srcDir, 'notification-service.ts'),
    [
      "import { Logger } from './logger.js';",
      'export class NotificationService {',
      '  private logger = new Logger();',
      '  send(userId: string, message: string): void {',
      '    this.logger.info(`Notifying ${userId}: ${message}`);',
      '  }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Cache service
  writeFileSync(
    join(srcDir, 'cache-service.ts'),
    [
      "import { Logger } from './logger.js';",
      'export class CacheService {',
      '  private logger = new Logger();',
      '  private store = new Map<string, string>();',
      '  get(key: string): string | undefined { return this.store.get(key); }',
      '  set(key: string, value: string): void { this.store.set(key, value); }',
      '  invalidate(key: string): void { this.store.delete(key); this.logger.info(`Invalidated ${key}`); }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // App controller
  writeFileSync(
    join(srcDir, 'app-controller.ts'),
    [
      "import { AuthService } from './auth-service.js';",
      "import { ProductService } from './product-service.js';",
      "import { OrderService } from './order-service.js';",
      "import { NotificationService } from './notification-service.js';",
      "import { CacheService } from './cache-service.js';",
      'export class AppController {',
      '  constructor(',
      '    private auth: AuthService,',
      '    private products: ProductService,',
      '    private orders: OrderService,',
      '    private notifications: NotificationService,',
      '    private cache: CacheService,',
      '  ) {}',
      '  handleLogin(email: string, password: string) {',
      '    const token = this.auth.login(email, password);',
      '    if (token) this.notifications.send(email, "Login successful");',
      '    return token;',
      '  }',
      '  handleSearch(query: string) {',
      '    const cached = this.cache.get(`search:${query}`);',
      '    if (cached) return cached;',
      '    const results = this.products.search(query);',
      '    this.cache.set(`search:${query}`, JSON.stringify(results));',
      '    return results;',
      '  }',
      '}',
    ].join('\n'),
    'utf-8',
  );

  // Main entry
  writeFileSync(
    join(srcDir, 'index.ts'),
    [
      "import { Database } from './database.js';",
      "import { UserRepository } from './user-repository.js';",
      "import { ProductRepository } from './product-repository.js';",
      "import { OrderRepository } from './order-repository.js';",
      "import { AuthService } from './auth-service.js';",
      "import { ProductService } from './product-service.js';",
      "import { OrderService } from './order-service.js';",
      "import { NotificationService } from './notification-service.js';",
      "import { CacheService } from './cache-service.js';",
      "import { AppController } from './app-controller.js';",
      'const db = new Database();',
      'db.connect();',
      'const auth = new AuthService(new UserRepository(db));',
      'const products = new ProductService(new ProductRepository(db));',
      'const orders = new OrderService(new OrderRepository(db), new ProductRepository(db));',
      'const notifications = new NotificationService();',
      'const cache = new CacheService();',
      'const app = new AppController(auth, products, orders, notifications, cache);',
      'export { app };',
    ].join('\n'),
    'utf-8',
  );

  // Config
  writeFileSync(
    join(rootPath, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' } }, null, 2),
    'utf-8',
  );
  writeFileSync(
    join(rootPath, 'package.json'),
    JSON.stringify({ name: 'perf-regression-project', version: '1.0.0' }, null, 2),
    'utf-8',
  );
}

// ── Tests ───────────────────────────────────────────────────

describe('performance regression', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-perf-'));
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // ── 1. Index throughput ──────────────────────────────────

  describe('index throughput', () => {
    it('completes full index with acceptable throughput and memory', async () => {
      createTestProject(tempRoot);
      const config = createConfig(tempRoot);
      writeConfig(tempRoot, config);

      const rssBefore = process.memoryUsage().rss;
      const startMs = performance.now();

      const manager = new IndexManager(tempRoot, config);
      await manager.fullIndex();

      const elapsedMs = performance.now() - startMs;
      const peakRssMb = process.memoryUsage().rss / 1024 / 1024;

      // Index should complete successfully
      const fileCount = Number(queryRows('SELECT COUNT(*) FROM files')[0][0]);
      expect(fileCount).toBeGreaterThan(0);

      const symbolCount = Number(queryRows('SELECT COUNT(*) FROM symbols')[0][0]);
      expect(symbolCount).toBeGreaterThan(0);

      // Parse throughput: at least 5 files/sec for a small project with workers=0
      const filesPerSec = (fileCount / elapsedMs) * 1000;
      expect(filesPerSec).toBeGreaterThanOrEqual(5);

      // Peak RSS under 500MB
      expect(peakRssMb).toBeLessThan(500);

      console.log(`[perf] index: ${fileCount} files, ${symbolCount} symbols, ${elapsedMs.toFixed(0)}ms, ${filesPerSec.toFixed(1)} files/sec, ${peakRssMb.toFixed(1)}MB RSS`);
    });
  });

  // ── 2. Search latency ───────────────────────────────────

  describe('search latency', () => {
    let searchEngine: HybridSearchEngine;

    beforeEach(async () => {
      createTestProject(tempRoot);
      const config = createConfig(tempRoot);
      writeConfig(tempRoot, config);
      const manager = new IndexManager(tempRoot, config);
      await manager.fullIndex();
      searchEngine = new HybridSearchEngine(getDatabaseSync());
    });

    it('completes keyword search queries under 500ms', async () => {
      const queries = ['login', 'UserRepository', 'Database', 'search', 'Logger'];

      for (const query of queries) {
        const startMs = performance.now();
        const results = await searchEngine.searchCode(query, {
          limit: 10,
          searchMode: 'keyword',
        });
        const elapsedMs = performance.now() - startMs;

        expect(elapsedMs).toBeLessThan(500);
        console.log(`[perf] keyword search "${query}": ${elapsedMs.toFixed(1)}ms, ${results.length} results`);
      }
    });

    it('returns non-empty results for known terms', async () => {
      const knownTerms = ['login', 'UserRepository', 'Logger'];

      for (const term of knownTerms) {
        const results = await searchEngine.searchCode(term, {
          limit: 10,
          searchMode: 'keyword',
        });
        expect(results.length).toBeGreaterThan(0);
      }
    });

    it('completes graph search queries under 500ms', async () => {
      const queries = ['login', 'search', 'order'];

      for (const query of queries) {
        const startMs = performance.now();
        const results = await searchEngine.searchCode(query, {
          limit: 10,
          searchMode: 'graph',
        });
        const elapsedMs = performance.now() - startMs;

        expect(elapsedMs).toBeLessThan(500);
        console.log(`[perf] graph search "${query}": ${elapsedMs.toFixed(1)}ms, ${results.length} results`);
      }
    });
  });

  // ── 3. Batch operations ─────────────────────────────────

  describe('batch database operations', () => {
    beforeEach(async () => {
      createTestProject(tempRoot);
      const config = createConfig(tempRoot);
      writeConfig(tempRoot, config);
      const manager = new IndexManager(tempRoot, config);
      await manager.fullIndex();
    });

    it('upsertEdges inserts multiple edges in a transaction', () => {
      const edges: EdgeRecord[] = Array.from({ length: 50 }, (_, i) => ({
        id: generateId('perf-edge', String(i)),
        fromId: generateId('perf-from', String(i)),
        toId: generateId('perf-to', String(i)),
        type: 'CALLS' as const,
        confidence: 0.9,
        evidence: `perfEdge${i}()`,
      }));

      const beforeCount = Number(queryRows('SELECT COUNT(*) FROM edges')[0][0]);
      upsertEdges(edges);
      const afterCount = Number(queryRows('SELECT COUNT(*) FROM edges')[0][0]);

      expect(afterCount).toBe(beforeCount + 50);

      // Verify a sample edge
      const sample = queryRows(
        'SELECT from_id, to_id, type, confidence FROM edges WHERE id = ?',
        [edges[0].id],
      );
      expect(sample).toHaveLength(1);
      expect(sample[0][2]).toBe('CALLS');
    });

    it('upsertChunks inserts multiple chunks in a transaction', () => {
      const fileId = String(queryRows('SELECT id FROM files LIMIT 1')[0][0]);
      const chunks: ChunkRecord[] = Array.from({ length: 30 }, (_, i) => ({
        id: generateId('perf-chunk', fileId, String(i)),
        fileId,
        symbolId: null,
        startByte: i * 100,
        endByte: (i + 1) * 100,
        startLine: i * 5,
        endLine: (i + 1) * 5,
        startColumn: 0,
        endColumn: 50,
        contentHash: generateId('hash', String(i)),
        content: `// perf chunk content ${i}`,
        tokenCount: 10 + i,
        summary: null,
        embeddingId: null,
      }));

      const beforeCount = Number(queryRows('SELECT COUNT(*) FROM chunks')[0][0]);
      upsertChunks(chunks);
      const afterCount = Number(queryRows('SELECT COUNT(*) FROM chunks')[0][0]);

      expect(afterCount).toBe(beforeCount + 30);

      // Verify a sample chunk
      const sample = queryRows(
        'SELECT content, token_count FROM chunks WHERE id = ?',
        [chunks[0].id],
      );
      expect(sample).toHaveLength(1);
      expect(sample[0][0]).toContain('perf chunk content 0');
    });

    it('batch delete operations remove data correctly', () => {
      // Insert edges for a known node, then delete them
      const nodeId = generateId('perf-delete-node', 'test');
      const edges: EdgeRecord[] = Array.from({ length: 20 }, (_, i) => ({
        id: generateId('perf-del-edge', String(i)),
        fromId: nodeId,
        toId: generateId('perf-del-to', String(i)),
        type: 'CALLS' as const,
        confidence: 1.0,
        evidence: null,
      }));
      upsertEdges(edges);

      const beforeEdgeCount = Number(
        queryRows('SELECT COUNT(*) FROM edges WHERE from_id = ?', [nodeId])[0][0],
      );
      expect(beforeEdgeCount).toBe(20);

      deleteEdgesByNodeId(nodeId);

      const afterEdgeCount = Number(
        queryRows('SELECT COUNT(*) FROM edges WHERE from_id = ?', [nodeId])[0][0],
      );
      expect(afterEdgeCount).toBe(0);

      // Insert chunks for a file, then delete them
      const fileId = String(queryRows('SELECT id FROM files LIMIT 1')[0][0]);
      const chunks: ChunkRecord[] = Array.from({ length: 10 }, (_, i) => ({
        id: generateId('perf-del-chunk', String(i)),
        fileId,
        symbolId: null,
        startByte: i * 50,
        endByte: (i + 1) * 50,
        startLine: i,
        endLine: i + 1,
        startColumn: 0,
        endColumn: 30,
        contentHash: generateId('delhash', String(i)),
        content: `// to be deleted ${i}`,
        tokenCount: 5,
        summary: null,
        embeddingId: null,
      }));
      upsertChunks(chunks);

      const beforeChunkCount = Number(
        queryRows('SELECT COUNT(*) FROM chunks WHERE file_id = ?', [fileId])[0][0],
      );
      expect(beforeChunkCount).toBeGreaterThanOrEqual(10);

      deleteChunksByFileId(fileId);

      const afterChunkCount = Number(
        queryRows('SELECT COUNT(*) FROM chunks WHERE file_id = ?', [fileId])[0][0],
      );
      expect(afterChunkCount).toBe(0);
    });
  });

  // ── 4. generateId performance ───────────────────────────

  describe('generateId performance', () => {
    it('generates 10000 IDs in under 100ms', () => {
      const startMs = performance.now();
      for (let i = 0; i < 10000; i++) {
        generateId('perf-test', 'module', String(i));
      }
      const elapsedMs = performance.now() - startMs;

      expect(elapsedMs).toBeLessThan(100);
      console.log(`[perf] generateId x10000: ${elapsedMs.toFixed(1)}ms`);
    });

    it('produces deterministic IDs for the same input', () => {
      const id1 = generateId('file', 'src/auth.ts');
      const id2 = generateId('file', 'src/auth.ts');
      expect(id1).toBe(id2);

      // Different inputs should produce different IDs
      const id3 = generateId('file', 'src/product.ts');
      expect(id1).not.toBe(id3);
    });

    it('produces 16 hex character IDs', () => {
      const id = generateId('symbol', 'AuthService', 'login');
      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});
