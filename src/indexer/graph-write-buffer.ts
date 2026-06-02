/**
 * Code Memory Graph — Graph Write Buffer
 *
 * Batches edge writes, evidence inserts, and call/route resolution updates
 * during a graph rebuild pass so the database IO is committed in a single
 * flush. When the buffer is inactive the calls are written through to the
 * underlying repositories immediately, preserving the existing single-edge
 * update path used outside of rebuilds.
 *
 * The original implementation lived as a handful of private methods on
 * `IndexManager`; this module extracts them into a reusable class so the
 * manager class can stop owning a piece of mutable buffer state.
 */

import type { EdgeRecord, EdgeType } from '../shared/types.js';
import { generateId } from '../shared/utils.js';
import {
  insertGraphEvidenceBatch,
  type GraphEdgeEvidenceInput,
} from '../storage/graph-evidence-repository.js';
import { upsertEdge, upsertEdges } from '../storage/edge-repository.js';
import {
  updateCallRefResolution,
  updateCallRefResolutions,
  updateRouteReferenceResolutions,
} from '../storage/parse-metadata-repository.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('graph-write-buffer');

export type CallResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous';

export interface GraphEdgeEvidenceMeta {
  sourceTable?: string | null;
  sourceId?: string | null;
  fileId?: string | null;
  startLine?: number | null;
  startColumn?: number | null;
}

export interface GraphEdgeEvidenceMeta {
  sourceTable?: string | null;
  sourceId?: string | null;
  fileId?: string | null;
  startLine?: number | null;
  startColumn?: number | null;
}

interface PendingGraphWrite {
  edge: EdgeRecord;
  evidence: GraphEdgeEvidenceInput;
}

interface CallResolutionUpdate {
  id: string;
  status: CallResolutionStatus;
}

export class GraphWriteBuffer {
  private active = false;
  private pendingWrites: PendingGraphWrite[] = [];
  private callResolutionUpdates: CallResolutionUpdate[] = [];
  private routeReferenceResolutionUpdates: CallResolutionUpdate[] = [];

  isActive(): boolean {
    return this.active;
  }

  begin(): void {
    this.active = true;
    this.pendingWrites = [];
    this.callResolutionUpdates = [];
    this.routeReferenceResolutionUpdates = [];
  }

  reset(): void {
    this.active = false;
    this.pendingWrites = [];
    this.callResolutionUpdates = [];
    this.routeReferenceResolutionUpdates = [];
  }

  flush(): void {
    if (this.pendingWrites.length > 0) {
      upsertEdges(this.pendingWrites.map((write) => write.edge));
      insertGraphEvidenceBatch(this.pendingWrites.map((write) => write.evidence));
    }
    if (this.callResolutionUpdates.length > 0) {
      updateCallRefResolutions(this.callResolutionUpdates);
    }
    if (this.routeReferenceResolutionUpdates.length > 0) {
      updateRouteReferenceResolutions(this.routeReferenceResolutionUpdates);
    }
  }

  upsertEdge(
    fromId: string,
    toId: string,
    type: EdgeType,
    confidence: number,
    evidence: string,
    evidenceMeta: GraphEdgeEvidenceMeta = {},
  ): number {
    const edge: EdgeRecord = {
      id: generateId('edge', fromId, toId, type),
      fromId,
      toId,
      type,
      confidence,
      evidence,
    };
    const evidenceRecord: GraphEdgeEvidenceInput = {
      edgeId: edge.id,
      sourceTable: evidenceMeta.sourceTable ?? 'graph_builder',
      sourceId: evidenceMeta.sourceId ?? null,
      fileId: evidenceMeta.fileId ?? null,
      startLine: evidenceMeta.startLine ?? 0,
      startColumn: evidenceMeta.startColumn ?? 0,
      evidence,
    };

    if (this.active) {
      this.pendingWrites.push({ edge, evidence: evidenceRecord });
      return 1;
    }

    try {
      upsertEdge(edge);
      insertGraphEvidenceBatch([evidenceRecord]);
      return 1;
    } catch (err) {
      log.warn('Failed to upsert graph edge from ' + fromId + ' to ' + toId + ': ' + (err instanceof Error ? err.message : String(err)));
      return 0;
    }
  }

  queueCallRefResolution(id: string, status: CallResolutionStatus): void {
    if (this.active) {
      this.callResolutionUpdates.push({ id, status });
      return;
    }
    updateCallRefResolution(id, status);
  }

  queueRouteReferenceResolution(id: string, status: CallResolutionStatus): void {
    if (this.active) {
      this.routeReferenceResolutionUpdates.push({ id, status });
      return;
    }
    updateRouteReferenceResolutions([{ id, status }]);
  }
}
