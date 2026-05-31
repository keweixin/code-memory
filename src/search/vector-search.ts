/**
 * Code Memory Graph — Vector Search
 *
 * Uses LanceDB for semantic vector search (ANN).
 * Provides embedding-based similarity search with metadata filtering.
 */

import * as lancedb from '@lancedb/lancedb';
import type { SearchResult, SymbolKind, SearchSource } from '../shared/types.js';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_SEARCH_LIMIT } from '../shared/constants.js';
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
}

export interface VectorSearchResult {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  score: number;
  distance: number;
}

let dbInstance: lancedb.Connection | null = null;
const TABLE_NAME = 'symbol_vectors';

/**
 * Initialize LanceDB connection and create table if needed.
 */
export async function initVectorStore(
  dbPath: string,
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Promise<lancedb.Connection> {
  if (dbInstance) return dbInstance;

  log.info(`Initializing LanceDB at: ${dbPath}`);

  dbInstance = await lancedb.connect(dbPath);

  // Check if table exists
  const tableNames = await dbInstance.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    // Create table with a placeholder record to establish schema
    const placeholder: VectorRecord = {
      id: '__schema_placeholder__',
      vector: new Array(dimensions).fill(0),
      name: '',
      kind: '',
      filePath: '',
      summary: '',
    };

    const table = await dbInstance.createTable(TABLE_NAME, [placeholder]);
    // Delete the placeholder
    await table.delete("id = '__schema_placeholder__'");
    log.info(`Created vector table with ${dimensions} dimensions`);
  }

  return dbInstance;
}

/**
 * Get the LanceDB connection.
 */
export function getVectorDb(): lancedb.Connection | null {
  return dbInstance;
}

/**
 * Add vector records to the store.
 */
export async function addVectors(records: VectorRecord[]): Promise<void> {
  if (!dbInstance) {
    throw new Error('Vector store not initialized. Call initVectorStore() first.');
  }

  if (records.length === 0) return;

  const table = await dbInstance.openTable(TABLE_NAME);
  await table.add(records);
  log.info(`Added ${records.length} vectors`);
}

/**
 * Delete vectors by ID.
 */
export async function deleteVectors(ids: string[]): Promise<void> {
  if (!dbInstance || ids.length === 0) return;

  const table = await dbInstance.openTable(TABLE_NAME);
  for (const id of ids) {
    await table.delete(`id = '${id}'`);
  }
  log.info(`Deleted ${ids.length} vectors`);
}

/**
 * Search for similar vectors using ANN.
 */
export async function searchVectors(
  queryVector: number[],
  options: VectorSearchOptions,
): Promise<VectorSearchResult[]> {
  if (!dbInstance) {
    log.warn('Vector store not initialized, skipping vector search');
    return [];
  }

  const { limit = DEFAULT_SEARCH_LIMIT, kindFilter, fileFilter } = options;

  try {
    const table = await dbInstance.openTable(TABLE_NAME);

    let query = table.search(queryVector).limit(limit * 2); // Over-fetch for filtering

    // Apply metadata filters
    if (kindFilter) {
      query = query.where(`kind = '${kindFilter}'`);
    }
    if (fileFilter) {
      query = query.where(`filePath LIKE '%${fileFilter}%'`);
    }

    const results = await query.toArray();

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

/**
 * Create an IVF-PQ index for faster ANN search on large datasets.
 * Only needed when vector count exceeds ~100k.
 */
export async function createVectorIndex(
  numPartitions: number = 256,
  numSubVectors: number = 16,
): Promise<void> {
  if (!dbInstance) return;

  try {
    const table = await dbInstance.openTable(TABLE_NAME);
    await table.createIndex('vector', {
      numPartitions,
      numSubVectors,
    } as any);
    log.info('Created IVF-PQ vector index');
  } catch (err) {
    log.warn(`Failed to create vector index: ${err instanceof Error ? err.message : String(err)}`);
  }
}
