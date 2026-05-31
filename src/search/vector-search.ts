/**
 * Code Memory Graph — Vector Search
 *
 * Uses LanceDB for semantic vector search (ANN).
 * Provides embedding-based similarity search with metadata filtering.
 */

import * as lancedb from '@lancedb/lancedb';
import { resolve } from 'node:path';
import type { EmbeddingConfig, SymbolKind } from '../shared/types.js';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_SEARCH_LIMIT } from '../shared/constants.js';
import { EmbeddingGenerator } from '../indexer/embedding-generator.js';
import { createLogger } from '../shared/logger.js';

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

let dbInstance: lancedb.Connection | null = null;
let dbInstancePath: string | null = null;
let dbInstanceDimensions = DEFAULT_EMBEDDING_DIMENSIONS;
const TABLE_NAME = 'symbol_vectors';

/**
 * Initialize LanceDB connection and create table if needed.
 */
export async function initVectorStore(
  dbPath: string,
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Promise<lancedb.Connection> {
  const resolvedPath = resolve(dbPath);
  if (dbInstance && dbInstancePath === resolvedPath) return dbInstance;

  if (dbInstance && dbInstancePath !== resolvedPath) {
    dbInstance.close();
    dbInstance = null;
    dbInstancePath = null;
  }

  log.info(`Initializing LanceDB at: ${resolvedPath}`);

  dbInstance = await lancedb.connect(resolvedPath);
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
export function getVectorDb(): lancedb.Connection | null {
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

/**
 * Add vector records to the store.
 */
export async function addVectors(records: VectorRecord[]): Promise<void> {
  if (records.length === 0) return;

  const connection = await ensureVectorConnection();
  await deleteVectors(records.map((record) => record.id));
  const table = await connection.openTable(TABLE_NAME);
  try {
    await table.add(records);
    log.info(`Added ${records.length} vectors`);
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
    for (const id of ids) {
      await table.delete(`id = '${escapeSqlString(id)}'`);
    }
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
    let results: any[];
    try {
      let query = table.vectorSearch(queryVector).limit(limit * 2); // Over-fetch for filtering

      if (kindFilter) {
        query = query.where(`kind = '${escapeSqlString(kindFilter)}'`);
      }
      if (fileFilter) {
        query = query.where(`filePath LIKE '%${escapeSqlLike(fileFilter)}%'`);
      }

      results = await query.toArray();
    } finally {
      table.close();
    }

    if (!results.length) return [];

    // Normalize distances to 0-1 scores
    const maxDistance = Math.max(...results.map((r: any) => r._distance || 0), 0.001);

    return results
      .slice(0, limit)
      .map((r: any) => ({
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

async function ensureVectorConnection(): Promise<lancedb.Connection> {
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
  projectRoot: string,
  config: EmbeddingConfig,
): Promise<VectorSearchProvider | null> {
  if (config.provider === 'none') return null;

  const dimensions = getEmbeddingDimensions(config);
  await initVectorStore(projectRoot, dimensions);
  return new LanceDbVectorSearchProvider(config);
}

export class LanceDbVectorSearchProvider implements VectorSearchProvider {
  private generator: EmbeddingGenerator;

  constructor(config: EmbeddingConfig) {
    this.generator = new EmbeddingGenerator(config);
  }

  isAvailable(): boolean {
    return this.generator.isAvailable() && Boolean(getVectorDb());
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
      await table.createIndex('vector', {
        numPartitions,
        numSubVectors,
      } as any);
    } finally {
      table.close();
    }
    log.info('Created IVF-PQ vector index');
  } catch (err) {
    log.warn(`Failed to create vector index: ${err instanceof Error ? err.message : String(err)}`);
  }
}
