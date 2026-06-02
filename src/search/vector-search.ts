/**
 * Code Memory Graph — Vector Search
 *
 * Uses LanceDB for semantic vector search (ANN).
 * Provides embedding-based similarity search with metadata filtering.
 */

import { resolve } from 'node:path';
import type { EmbeddingConfig, SymbolKind } from '../shared/types.js';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_SEARCH_LIMIT } from '../shared/constants.js';
import { EmbeddingGenerator } from '../indexer/embedding-generator.js';
import { createLogger } from '../shared/logger.js';
import { resolveEmbeddingConfig } from '../shared/provider-config.js';

type LanceDBModule = typeof import('@lancedb/lancedb');
type LanceDBConnection = InstanceType<LanceDBModule['Connection']>;

let _lancedb: LanceDBModule | null = null;

async function getLanceDB(): Promise<LanceDBModule> {
  if (!_lancedb) {
    _lancedb = await import('@lancedb/lancedb');
  }
  return _lancedb;
}

const log = createLogger('vector-search');

export interface VectorSearchOptions {
  query: string;
  queryVector: number[];
  limit?: number;
  kindFilter?: SymbolKind;
  fileFilter?: string;
}

export interface VectorRecord {
  [key: string]: unknown;
  id: string;
  vector: number[];
  name: string;
  kind: string;
  filePath: string;
  summary: string;
  chunkId: string;
  contentHash: string;
}

export interface VectorSearchResult {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  score: number;
  distance: number;
}

export interface VectorStoreStats {
  available: boolean;
  rowCount: number;
  dimensions: number | null;
  tableName: string;
  error?: string;
}

export interface VectorSearchProvider {
  isAvailable(): boolean;
  search(
    query: string,
    options: {
      limit?: number;
      kindFilter?: SymbolKind;
      fileFilter?: string;
    },
  ): Promise<Array<{ id: string; rank: number }>>;
}

interface LanceVectorRow {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  _distance: number;
}

let dbInstance: LanceDBConnection | null = null;
let dbInstancePath: string | null = null;
let dbInstanceDimensions = DEFAULT_EMBEDDING_DIMENSIONS;
const TABLE_NAME = 'symbol_vectors';

/**
 * Initialize LanceDB connection and create table if needed.
 */
export async function initVectorStore(
  dbPath: string,
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Promise<LanceDBConnection> {
  const resolvedPath = resolve(dbPath);
  if (dbInstance && dbInstancePath === resolvedPath) return dbInstance;

  if (dbInstance && dbInstancePath !== resolvedPath) {
    dbInstance.close();
    dbInstance = null;
    dbInstancePath = null;
  }

  log.info(`Initializing LanceDB at: ${resolvedPath}`);

  const ldb = await getLanceDB();
  dbInstance = await ldb.connect(resolvedPath);
  dbInstancePath = resolvedPath;
  dbInstanceDimensions = dimensions;

  // Check if table exists
  const tableNames = await dbInstance.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    // Create table with a placeholder record to establish schema
    await createVectorTable(dimensions);
    log.info(`Created vector table with ${dimensions} dimensions`);
  }

  return dbInstance;
}

export async function resetVectorStore(
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Promise<void> {
  if (!dbInstance) {
    throw new Error('Vector store not initialized. Call initVectorStore() first.');
  }

  const tableNames = await dbInstance.tableNames();
  if (tableNames.includes(TABLE_NAME)) {
    await dbInstance.dropTable(TABLE_NAME);
  }
  await createVectorTable(dimensions);
  log.info(`Reset vector table with ${dimensions} dimensions`);
}

/**
 * Get the LanceDB connection.
 */
export function getVectorDb(): LanceDBConnection | null {
  return dbInstance;
}

export function closeVectorStore(): void {
  if (dbInstance) {
    dbInstance.close();
  }
  dbInstance = null;
  dbInstancePath = null;
}

export function releaseVectorStoreConnection(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export async function getVectorStoreStats(
  dbPath: string,
  _dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Promise<VectorStoreStats> {
  try {
    const ldb = await getLanceDB();
    const connection = await ldb.connect(resolve(dbPath));
    const tableNames = await connection.tableNames();
    if (!tableNames.includes(TABLE_NAME)) {
      connection.close();
      return {
        available: false,
        rowCount: 0,
        dimensions: null,
        tableName: TABLE_NAME,
        error: 'Vector table does not exist.',
      };
    }

    const table = await connection.openTable(TABLE_NAME);
    try {
      const rowCount = await table.countRows("id != '__schema_placeholder__'");
      const sampleRows = rowCount > 0
        ? await table.query()
          .where("id != '__schema_placeholder__'")
          .select(['vector'])
          .limit(1)
          .toArray()
        : [];
      const sampleVector = sampleRows[0]?.vector;
      return {
        available: true,
        rowCount,
        dimensions: Array.isArray(sampleVector) ? sampleVector.length : null,
        tableName: TABLE_NAME,
      };
    } finally {
      table.close();
      connection.close();
    }
  } catch (err) {
    return {
      available: false,
      rowCount: 0,
      dimensions: null,
      tableName: TABLE_NAME,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Add vector records to the store.
 */
export async function addVectors(records: VectorRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  const connection = await ensureVectorConnection();
  await deleteVectors(records.map((record) => record.id));
  const validRecords = records.filter((record) => assertVectorDimensions(record.vector, dbInstanceDimensions));
  if (validRecords.length !== records.length) {
    log.warn(`Skipped ${records.length - validRecords.length} vectors with mismatched dimensions`);
  }
  if (validRecords.length === 0) return 0;

  const table = await connection.openTable(TABLE_NAME);
  try {
    await table.add(validRecords);
    log.info(`Added ${validRecords.length} vectors`);
    return validRecords.length;
  } finally {
    table.close();
  }
}

/**
 * Delete vectors by ID.
 */
export async function deleteVectors(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const connection = await ensureVectorConnection();

  const table = await connection.openTable(TABLE_NAME);
  try {
    const escaped = ids.map((id) => `'${escapeSqlString(id)}'`).join(',');
    await table.delete(`id IN (${escaped})`);
    log.info(`Deleted ${ids.length} vectors`);
  } finally {
    table.close();
  }
}

/**
 * Search for similar vectors using ANN.
 */
export async function searchVectors(
  queryVector: number[],
  options: VectorSearchOptions,
): Promise<VectorSearchResult[]> {
  if (!dbInstance) {
    try {
      await ensureVectorConnection();
    } catch {
      log.warn('Vector store not initialized, skipping vector search');
      return [];
    }
  }

  const { limit = DEFAULT_SEARCH_LIMIT, kindFilter, fileFilter } = options;

  try {
    const table = await dbInstance!.openTable(TABLE_NAME);
    let results: LanceVectorRow[];
    try {
      let query = table.vectorSearch(queryVector).limit(limit * 2); // Over-fetch for filtering

      if (kindFilter) {
        query = query.where(`kind = '${escapeSqlString(kindFilter)}'`);
      }
      if (fileFilter) {
        query = query.where(`filePath LIKE '%${escapeSqlLike(fileFilter)}%'`);
      }

      results = (await query.toArray()).filter(isLanceVectorRow);
    } finally {
      table.close();
    }

    if (!results.length) return [];

    // Normalize distances to 0-1 scores
    const maxDistance = Math.max(...results.map((r) => r._distance || 0), 0.001);

    return results
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        filePath: r.filePath,
        score: 1 - (r._distance / maxDistance),
        distance: r._distance,
      }));
  } catch (err) {
    log.warn(`Vector search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function ensureVectorConnection(): Promise<LanceDBConnection> {
  if (dbInstance) return dbInstance;
  if (!dbInstancePath) {
    throw new Error('Vector store not initialized. Call initVectorStore() first.');
  }
  return initVectorStore(dbInstancePath, dbInstanceDimensions);
}

export function getEmbeddingDimensions(config: EmbeddingConfig): number {
  if (config.dimensions && config.dimensions > 0) return config.dimensions;
  return config.provider === 'openai' ? 1536 : DEFAULT_EMBEDDING_DIMENSIONS;
}

export async function createVectorSearchProvider(
  vectorDbPath: string,
  config: EmbeddingConfig,
): Promise<VectorSearchProvider | null> {
  const resolvedConfig = resolveEmbeddingConfig(config).config;
  if (resolvedConfig.provider === 'none') return null;

  const dimensions = getEmbeddingDimensions(resolvedConfig);
  await initVectorStore(vectorDbPath, dimensions);
  return new LanceDbVectorSearchProvider(resolvedConfig, vectorDbPath, dimensions);
}

export class LanceDbVectorSearchProvider implements VectorSearchProvider {
  private generator: EmbeddingGenerator;
  private vectorDbPath: string | null;
  private dimensions: number;

  constructor(
    config: EmbeddingConfig,
    vectorDbPath: string | null = null,
    dimensions: number = getEmbeddingDimensions(config),
  ) {
    this.generator = new EmbeddingGenerator(config);
    this.vectorDbPath = vectorDbPath;
    this.dimensions = dimensions;
  }

  isAvailable(): boolean {
    return this.generator.isAvailable() && (Boolean(this.vectorDbPath) || Boolean(getVectorDb()));
  }

  async search(
    query: string,
    options: {
      limit?: number;
      kindFilter?: SymbolKind;
      fileFilter?: string;
    } = {},
  ): Promise<Array<{ id: string; rank: number }>> {
    if (!this.isAvailable()) return [];
    if (this.vectorDbPath) {
      await initVectorStore(this.vectorDbPath, this.dimensions);
    }
    const queryVector = await this.generator.generate(query);
    if (queryVector.length === 0) return [];
    const results = await searchVectors(queryVector, {
      query,
      queryVector,
      limit: options.limit,
      kindFilter: options.kindFilter,
      fileFilter: options.fileFilter,
    });
    return results.map((result, index) => ({
      id: result.id,
      rank: index + 1,
    }));
  }
}

function createVectorPlaceholder(dimensions: number): VectorRecord {
  return {
    id: '__schema_placeholder__',
    vector: new Array(dimensions).fill(0),
    name: '',
    kind: '',
    filePath: '',
    summary: '',
    chunkId: '',
    contentHash: '',
  };
}

async function createVectorTable(dimensions: number): Promise<void> {
  if (!dbInstance) {
    throw new Error('Vector store not initialized. Call initVectorStore() first.');
  }
  const table = await dbInstance.createTable(TABLE_NAME, [createVectorPlaceholder(dimensions)]);
  try {
    await table.delete("id = '__schema_placeholder__'");
  } finally {
    table.close();
  }
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeSqlLike(value: string): string {
  return escapeSqlString(value).replace(/[%_]/g, (match) => '\\' + match);
}

function assertVectorDimensions(vector: number[], expected: number): boolean {
  return vector.length === expected;
}

function isLanceVectorRow(value: unknown): value is LanceVectorRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' &&
    typeof row.name === 'string' &&
    typeof row.kind === 'string' &&
    typeof row.filePath === 'string' &&
    typeof row._distance === 'number';
}

/**
 * Create an IVF-PQ index for faster ANN search on large datasets.
 * Only needed when vector count exceeds ~100k.
 */
export async function createVectorIndex(
  numPartitions: number = 256,
  numSubVectors: number = 16,
): Promise<void> {
  try {
    const connection = await ensureVectorConnection();
    const table = await connection.openTable(TABLE_NAME);
    try {
      const ldb = await getLanceDB();
      await table.createIndex('vector', {
        config: ldb.Index.ivfPq({
          numPartitions,
          numSubVectors,
        }),
      });
    } finally {
      table.close();
    }
    log.info('Created IVF-PQ vector index');
  } catch (err) {
    log.warn(`Failed to create vector index: ${err instanceof Error ? err.message : String(err)}`);
  }
}
