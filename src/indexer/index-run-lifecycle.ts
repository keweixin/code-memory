import { randomUUID } from 'node:crypto';

export type IndexRunMode = 'full' | 'incremental';

export function createIndexRunId(mode: IndexRunMode): string {
  return mode + '-' + new Date().toISOString() + '-' + randomUUID();
}

export function beginIndexRunMetadata(runId: string, mode: IndexRunMode): Record<string, string> {
  const now = new Date().toISOString();
  return {
    index_run_id: runId,
    index_status: 'indexing',
    index_run_mode: mode,
    index_started_at: now,
    index_completed_at: '',
    last_index_error: '',
    is_indexing: 'true',
  };
}

export function committingIndexRunMetadata(runId: string): Record<string, string> {
  return {
    index_run_id: runId,
    index_status: 'committing',
    is_indexing: 'true',
  };
}

export function completedIndexRunMetadata(runId: string): Record<string, string> {
  const now = new Date().toISOString();
  return {
    index_run_id: runId,
    index_status: 'completed',
    index_completed_at: now,
    last_index_error: '',
    is_indexing: 'false',
  };
}

export function failedIndexRunMetadata(runId: string, err: unknown): Record<string, string> {
  const now = new Date().toISOString();
  return {
    index_run_id: runId,
    index_status: isInterruptedError(err) ? 'interrupted' : 'failed',
    index_completed_at: now,
    last_index_error: err instanceof Error ? err.message : String(err),
    is_indexing: 'false',
  };
}

function isInterruptedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes('sigint') || message.includes('sigterm') || message.includes('interrupted');
}
