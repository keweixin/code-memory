import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphWriteBuffer } from '../src/indexer/graph-write-buffer.js';

const {
  upsertEdgeMock,
  upsertEdgesMock,
  insertGraphEvidenceBatchMock,
  updateCallRefResolutionMock,
  updateCallRefResolutionsMock,
  updateRouteReferenceResolutionsMock,
  generateIdMock,
} = vi.hoisted(() => ({
  upsertEdgeMock: vi.fn(),
  upsertEdgesMock: vi.fn(),
  insertGraphEvidenceBatchMock: vi.fn(),
  updateCallRefResolutionMock: vi.fn(),
  updateCallRefResolutionsMock: vi.fn(),
  updateRouteReferenceResolutionsMock: vi.fn(),
  generateIdMock: vi.fn(() => 'edge:from:to:IMPORTS'),
}));

vi.mock('../src/storage/edge-repository.js', () => ({
  upsertEdge: upsertEdgeMock,
  upsertEdges: upsertEdgesMock,
}));

vi.mock('../src/storage/graph-evidence-repository.js', () => ({
  insertGraphEvidenceBatch: insertGraphEvidenceBatchMock,
}));

vi.mock('../src/storage/parse-metadata-repository.js', () => ({
  updateCallRefResolution: updateCallRefResolutionMock,
  updateCallRefResolutions: updateCallRefResolutionsMock,
  updateRouteReferenceResolutions: updateRouteReferenceResolutionsMock,
}));

vi.mock('../src/shared/utils.js', () => ({
  generateId: generateIdMock,
}));

describe('GraphWriteBuffer', () => {
  beforeEach(() => {
    upsertEdgeMock.mockReset();
    upsertEdgesMock.mockReset();
    insertGraphEvidenceBatchMock.mockReset();
    updateCallRefResolutionMock.mockReset();
    updateCallRefResolutionsMock.mockReset();
    updateRouteReferenceResolutionsMock.mockReset();
    generateIdMock.mockClear();
  });

  it('writes through to repositories when no buffer is active', () => {
    const buffer = new GraphWriteBuffer();
    expect(buffer.isActive()).toBe(false);

    const result = buffer.upsertEdge('a', 'b', 'IMPORTS', 0.9, 'evidence', {
      sourceTable: 'files',
      sourceId: 'src-1',
      fileId: 'file-1',
      startLine: 10,
      startColumn: 4,
    });

    expect(result).toBe(1);
    expect(upsertEdgeMock).toHaveBeenCalledTimes(1);
    expect(insertGraphEvidenceBatchMock).toHaveBeenCalledTimes(1);
    const evidence = insertGraphEvidenceBatchMock.mock.calls[0]![0]!;
    expect(evidence[0]).toMatchObject({
      sourceTable: 'files',
      sourceId: 'src-1',
      fileId: 'file-1',
      startLine: 10,
      startColumn: 4,
      evidence: 'evidence',
    });
  });

  it('uses a default source table when the caller omits it', () => {
    const buffer = new GraphWriteBuffer();
    buffer.upsertEdge('a', 'b', 'IMPORTS', 0.9, 'evidence');
    const evidence = insertGraphEvidenceBatchMock.mock.calls[0]![0]![0]!;
    expect(evidence.sourceTable).toBe('graph_builder');
    expect(evidence.sourceId).toBeNull();
    expect(evidence.fileId).toBeNull();
    expect(evidence.startLine).toBe(0);
    expect(evidence.startColumn).toBe(0);
  });

  it('returns 0 and logs a warning when the underlying write throws', () => {
    const buffer = new GraphWriteBuffer();
    upsertEdgeMock.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = buffer.upsertEdge('a', 'b', 'IMPORTS', 0.9, 'evidence');
    expect(result).toBe(0);
  });

  it('batches edge writes and flushes them as a single batch', () => {
    const buffer = new GraphWriteBuffer();
    buffer.begin();
    expect(buffer.isActive()).toBe(true);

    buffer.upsertEdge('a', 'b', 'IMPORTS', 0.9, 'ev1');
    buffer.upsertEdge('a', 'c', 'CALLS', 0.8, 'ev2');
    buffer.upsertEdge('a', 'd', 'REFERENCES', 0.7, 'ev3');

    expect(upsertEdgesMock).not.toHaveBeenCalled();
    expect(insertGraphEvidenceBatchMock).not.toHaveBeenCalled();

    buffer.flush();
    expect(upsertEdgesMock).toHaveBeenCalledTimes(1);
    expect(upsertEdgesMock.mock.calls[0]![0]).toHaveLength(3);
    expect(insertGraphEvidenceBatchMock).toHaveBeenCalledTimes(1);
    expect(insertGraphEvidenceBatchMock.mock.calls[0]![0]).toHaveLength(3);
  });

  it('batches call ref resolutions and flushes them as a single batch', () => {
    const buffer = new GraphWriteBuffer();
    buffer.begin();
    buffer.queueCallRefResolution('call-1', 'resolved');
    buffer.queueCallRefResolution('call-2', 'unresolved');
    expect(updateCallRefResolutionsMock).not.toHaveBeenCalled();

    buffer.flush();
    expect(updateCallRefResolutionsMock).toHaveBeenCalledTimes(1);
    expect(updateCallRefResolutionsMock.mock.calls[0]![0]).toEqual([
      { id: 'call-1', status: 'resolved' },
      { id: 'call-2', status: 'unresolved' },
    ]);
  });

  it('batches route reference resolutions and flushes them as a single batch', () => {
    const buffer = new GraphWriteBuffer();
    buffer.begin();
    buffer.queueRouteReferenceResolution('route-1', 'ambiguous');
    buffer.queueRouteReferenceResolution('route-2', 'resolved');
    expect(updateRouteReferenceResolutionsMock).not.toHaveBeenCalled();

    buffer.flush();
    expect(updateRouteReferenceResolutionsMock).toHaveBeenCalledTimes(1);
    expect(updateRouteReferenceResolutionsMock.mock.calls[0]![0]).toEqual([
      { id: 'route-1', status: 'ambiguous' },
      { id: 'route-2', status: 'resolved' },
    ]);
  });

  it('reset() drops pending writes and disables the buffer', () => {
    const buffer = new GraphWriteBuffer();
    buffer.begin();
    buffer.upsertEdge('a', 'b', 'IMPORTS', 0.9, 'ev');
    buffer.queueCallRefResolution('call-1', 'resolved');

    buffer.reset();
    expect(buffer.isActive()).toBe(false);
    expect(upsertEdgesMock).not.toHaveBeenCalled();
    expect(updateCallRefResolutionsMock).not.toHaveBeenCalled();

    buffer.flush();
    expect(upsertEdgesMock).not.toHaveBeenCalled();
    expect(insertGraphEvidenceBatchMock).not.toHaveBeenCalled();
  });

  it('flush() is a no-op when nothing is buffered', () => {
    const buffer = new GraphWriteBuffer();
    buffer.flush();
    expect(upsertEdgesMock).not.toHaveBeenCalled();
    expect(insertGraphEvidenceBatchMock).not.toHaveBeenCalled();
    expect(updateCallRefResolutionsMock).not.toHaveBeenCalled();
    expect(updateRouteReferenceResolutionsMock).not.toHaveBeenCalled();
  });

  it('writes through to single-item update when the buffer is inactive (call ref)', () => {
    const buffer = new GraphWriteBuffer();
    buffer.queueCallRefResolution('call-1', 'resolved');
    expect(updateCallRefResolutionMock).toHaveBeenCalledWith('call-1', 'resolved');
    expect(updateCallRefResolutionsMock).not.toHaveBeenCalled();
  });

  it('writes through to batched update when the buffer is inactive (route reference)', () => {
    const buffer = new GraphWriteBuffer();
    buffer.queueRouteReferenceResolution('route-1', 'ambiguous');
    expect(updateRouteReferenceResolutionsMock).toHaveBeenCalledWith([
      { id: 'route-1', status: 'ambiguous' },
    ]);
  });

  it('begin() reinitializes pending state for a new pass', () => {
    const buffer = new GraphWriteBuffer();
    buffer.begin();
    buffer.upsertEdge('a', 'b', 'IMPORTS', 0.9, 'ev-1');
    buffer.begin();
    buffer.upsertEdge('a', 'b', 'CALLS', 0.5, 'ev-2');

    buffer.flush();
    expect(upsertEdgesMock.mock.calls[0]![0]).toHaveLength(1);
    expect(upsertEdgesMock.mock.calls[0]![0]![0]!.type).toBe('CALLS');
  });

  it('generates a deterministic edge id using the from/to/type tuple', () => {
    const buffer = new GraphWriteBuffer();
    buffer.upsertEdge('from-id', 'to-id', 'IMPORTS', 0.9, 'ev');
    expect(generateIdMock).toHaveBeenCalledWith('edge', 'from-id', 'to-id', 'IMPORTS');
  });
});
