/**
 * Parse metadata persistence. These tables are the second-stage graph
 * builder's source of truth, so edge rebuilding never needs to read files.
 */

import type {
  CallReference,
  ImportInfo,
  RouteEndpointRecord,
  RouteReferenceRecord,
  ScopeBindingRecord,
  TypeRelationRecord,
} from '../shared/types.js';
import { generateId } from '../shared/utils.js';
import { getDatabaseSync } from './database.js';

export interface StoredImportRow {
  file_id: string;
  source: string;
  imported_name: string | null;
  local_name: string | null;
  kind: string;
  is_type_only: number;
  start_line: number;
  start_column: number;
}

export interface StoredCallRefRow {
  id: string;
  file_id: string;
  caller_symbol_id: string | null;
  caller_name: string | null;
  caller_start_line: number | null;
  caller_class_name: string | null;
  callee_name: string;
  receiver_name: string | null;
  receiver_kind: string | null;
  member_name: string | null;
  is_constructor_call: number;
  start_line: number;
  start_column: number;
  evidence: string | null;
  resolution_status: string;
}

export interface StoredExportRow {
  file_id: string;
  exported_name: string;
  local_name: string | null;
  source: string | null;
  kind: string;
  start_line: number;
  start_column: number;
}

export interface StoredScopeBindingRow {
  id: string;
  file_id: string;
  symbol_id: string | null;
  local_name: string;
  binding_kind: string;
  target_name: string | null;
  target_symbol_id: string | null;
  start_line: number;
  end_line: number;
}

export interface StoredTypeRelationRow {
  id: string;
  file_id: string;
  from_symbol_id: string | null;
  relation_kind: string;
  target_name: string;
  target_symbol_id: string | null;
  evidence: string | null;
}

export interface StoredRouteEndpointRow {
  id: string;
  file_id: string;
  symbol_id: string | null;
  route_path: string;
  http_method: string;
  framework: string;
  start_line: number;
  start_column: number;
  evidence: string | null;
}

export interface StoredRouteReferenceRow {
  id: string;
  file_id: string;
  caller_symbol_id: string | null;
  route_path: string;
  http_method: string | null;
  framework: string;
  start_line: number;
  start_column: number;
  evidence: string | null;
  resolution_status: string;
}

export function deleteParseMetadataByFileId(fileId: string): void {
  const db = getDatabaseSync();
  for (const table of ['file_imports', 'file_exports', 'call_refs', 'scope_bindings', 'type_relations', 'route_endpoints', 'route_references']) {
    db.run(`DELETE FROM ${table} WHERE file_id = ?`, [fileId]);
  }
}

export function replaceParseMetadata(params: {
  fileId: string;
  imports: ImportInfo[];
  exports: string[];
  calls: CallReference[];
  scopeBindings: ScopeBindingRecord[];
  typeRelations: TypeRelationRecord[];
  routeEndpoints: RouteEndpointRecord[];
  routeReferences: RouteReferenceRecord[];
}): void {
  const db = getDatabaseSync();

  const insertImport = db.native.prepare(
    `INSERT OR REPLACE INTO file_imports
      (id, file_id, source, imported_name, local_name, kind, is_type_only, start_line, start_column)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertExport = db.native.prepare(
    `INSERT OR REPLACE INTO file_exports
      (id, file_id, exported_name, local_name, source, kind, start_line, start_column)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCall = db.native.prepare(
    `INSERT OR REPLACE INTO call_refs
      (id, file_id, caller_symbol_id, caller_name, caller_start_line, caller_class_name,
       callee_name, receiver_name, receiver_kind, member_name, is_constructor_call,
       start_line, start_column, evidence, resolution_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertScopeBinding = db.native.prepare(
    `INSERT OR REPLACE INTO scope_bindings
      (id, file_id, symbol_id, local_name, binding_kind, target_name, target_symbol_id, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTypeRelation = db.native.prepare(
    `INSERT OR REPLACE INTO type_relations
      (id, file_id, from_symbol_id, relation_kind, target_name, target_symbol_id, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRouteEndpoint = db.native.prepare(
    `INSERT OR REPLACE INTO route_endpoints
      (id, file_id, symbol_id, route_path, http_method, framework, start_line, start_column, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRouteReference = db.native.prepare(
    `INSERT OR REPLACE INTO route_references
      (id, file_id, caller_symbol_id, route_path, http_method, framework,
       start_line, start_column, evidence, resolution_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const write = db.native.transaction(() => {
    for (const table of ['file_imports', 'file_exports', 'call_refs', 'scope_bindings', 'type_relations', 'route_endpoints', 'route_references']) {
      db.run(`DELETE FROM ${table} WHERE file_id = ?`, [params.fileId]);
    }

    for (const imp of params.imports) {
      const entries = materializeImportEntries(params.fileId, imp);
      for (const entry of entries) {
        insertImport.run(
          entry.id,
          params.fileId,
          imp.source,
          entry.importedName,
          entry.localName,
          entry.kind,
          imp.isTypeOnly ? 1 : 0,
          imp.startLine ?? 0,
          imp.startColumn ?? 0,
        );
      }
    }

    params.exports.forEach((exportedName, index) => {
      const parsed = parseExportMetadata(exportedName);
      insertExport.run(
        generateId('file_export', params.fileId, String(index), exportedName),
        params.fileId,
        parsed.exportedName,
        parsed.localName,
        parsed.source,
        parsed.kind,
        0,
        0,
      );
    });

    params.calls.forEach((call, index) => {
      insertCall.run(
        generateId('call_ref', params.fileId, String(index), String(call.rangeStart), call.evidence),
        params.fileId,
        call.callerSymbolId ?? null,
        call.callerName,
        call.callerStartLine,
        call.callerClassName ?? null,
        call.calleeName,
        call.receiverName ?? null,
        call.receiverKind ?? null,
        call.memberName ?? null,
        call.isConstructorCall ? 1 : 0,
        call.rangeStart,
        call.startColumn ?? 0,
        call.evidence,
        'unresolved',
      );
    });

    params.scopeBindings.forEach((binding, index) => {
      insertScopeBinding.run(
        generateId('scope_binding', params.fileId, String(index), binding.localName, String(binding.startLine)),
        params.fileId,
        binding.symbolId,
        binding.localName,
        binding.bindingKind,
        binding.targetName,
        binding.targetSymbolId,
        binding.startLine,
        binding.endLine,
      );
    });

    params.typeRelations.forEach((relation, index) => {
      insertTypeRelation.run(
        generateId('type_relation', params.fileId, String(index), relation.relationKind, relation.targetName),
        params.fileId,
        relation.fromSymbolId,
        relation.relationKind,
        relation.targetName,
        relation.targetSymbolId,
        relation.evidence,
      );
    });

    params.routeEndpoints.forEach((endpoint, index) => {
      insertRouteEndpoint.run(
        generateId('route_endpoint', params.fileId, String(index), endpoint.httpMethod, endpoint.routePath),
        params.fileId,
        endpoint.symbolId,
        endpoint.routePath,
        endpoint.httpMethod,
        endpoint.framework,
        endpoint.startLine,
        endpoint.startColumn,
        endpoint.evidence,
      );
    });

    params.routeReferences.forEach((reference, index) => {
      insertRouteReference.run(
        generateId('route_reference', params.fileId, String(index), reference.httpMethod ?? '', reference.routePath, String(reference.startLine)),
        params.fileId,
        reference.callerSymbolId,
        reference.routePath,
        reference.httpMethod,
        reference.framework,
        reference.startLine,
        reference.startColumn,
        reference.evidence,
        'unresolved',
      );
    });
  });

  write();
}

export function getCallRefsByFileIds(fileIds?: string[]): StoredCallRefRow[] {
  return getRowsByFileIds<StoredCallRefRow>('call_refs', fileIds);
}

export function getFileExportsByFileIds(fileIds?: string[]): StoredExportRow[] {
  return getRowsByFileIds<StoredExportRow>('file_exports', fileIds);
}

export function getScopeBindingsByFileIds(fileIds?: string[]): StoredScopeBindingRow[] {
  return getRowsByFileIds<StoredScopeBindingRow>('scope_bindings', fileIds);
}

export function getTypeRelationsByFileIds(fileIds?: string[]): StoredTypeRelationRow[] {
  return getRowsByFileIds<StoredTypeRelationRow>('type_relations', fileIds);
}

export function getRouteEndpointsByFileIds(fileIds?: string[]): StoredRouteEndpointRow[] {
  return getRowsByFileIds<StoredRouteEndpointRow>('route_endpoints', fileIds);
}

export function getRouteReferencesByFileIds(fileIds?: string[]): StoredRouteReferenceRow[] {
  return getRowsByFileIds<StoredRouteReferenceRow>('route_references', fileIds);
}

export function updateCallRefResolution(id: string, status: 'resolved' | 'unresolved' | 'ambiguous'): void {
  getDatabaseSync().run('UPDATE call_refs SET resolution_status = ? WHERE id = ?', [status, id]);
}

export function updateCallRefResolutions(updates: Array<{
  id: string;
  status: 'resolved' | 'unresolved' | 'ambiguous';
}>): void {
  if (updates.length === 0) return;
  const db = getDatabaseSync();
  const stmt = db.native.prepare('UPDATE call_refs SET resolution_status = ? WHERE id = ?');
  const write = db.native.transaction((items: Array<{ id: string; status: 'resolved' | 'unresolved' | 'ambiguous' }>) => {
    for (const item of items) stmt.run(item.status, item.id);
  });
  write(updates);
}

export function updateRouteReferenceResolutions(updates: Array<{
  id: string;
  status: 'resolved' | 'unresolved' | 'ambiguous';
}>): void {
  if (updates.length === 0) return;
  const db = getDatabaseSync();
  const stmt = db.native.prepare('UPDATE route_references SET resolution_status = ? WHERE id = ?');
  const write = db.native.transaction((items: Array<{ id: string; status: 'resolved' | 'unresolved' | 'ambiguous' }>) => {
    for (const item of items) stmt.run(item.status, item.id);
  });
  write(updates);
}

export function countUnresolvedCalls(): number {
  const result = getDatabaseSync().exec(
    "SELECT COUNT(*) FROM call_refs WHERE resolution_status != 'resolved'",
  );
  return Number(result[0]?.values[0]?.[0] ?? 0);
}

function getRowsByFileIds<T>(table: string, fileIds?: string[]): T[] {
  const db = getDatabaseSync();
  if (!fileIds || fileIds.length === 0) {
    return db.all<T>(`SELECT * FROM ${table}`);
  }
  const placeholders = fileIds.map(() => '?').join(',');
  return db.all<T>(`SELECT * FROM ${table} WHERE file_id IN (${placeholders})`, fileIds);
}

function materializeImportEntries(fileId: string, imp: ImportInfo): Array<{
  id: string;
  importedName: string | null;
  localName: string | null;
  kind: string;
}> {
  const entries: Array<{ id: string; importedName: string | null; localName: string | null; kind: string }> = [];

  if (imp.defaultName) {
    entries.push({
      id: generateId('file_import', fileId, imp.source, 'default', imp.defaultName, String(imp.startLine ?? 0)),
      importedName: 'default',
      localName: imp.defaultName,
      kind: 'default',
    });
  }

  if (imp.isNamespace) {
    const localName = Object.keys(imp.aliases || {})[0] ?? imp.names[0] ?? imp.defaultName ?? null;
    entries.push({
      id: generateId('file_import', fileId, imp.source, 'namespace', localName ?? '', String(imp.startLine ?? 0)),
      importedName: '*',
      localName,
      kind: 'namespace',
    });
  }

  for (const importedName of imp.names) {
    if (imp.isNamespace && importedName === (Object.keys(imp.aliases || {})[0] ?? imp.names[0])) continue;
    const localName = Object.entries(imp.aliases || {})
      .find(([, exported]) => exported === importedName)?.[0] ?? importedName;
    entries.push({
      id: generateId('file_import', fileId, imp.source, importedName, localName, String(imp.startLine ?? 0)),
      importedName,
      localName,
      kind: 'named',
    });
  }

  if (entries.length === 0) {
    entries.push({
      id: generateId('file_import', fileId, imp.source, 'side_effect', String(imp.startLine ?? 0)),
      importedName: null,
      localName: null,
      kind: 'side_effect',
    });
  }

  return entries;
}

function parseExportMetadata(value: string): {
  exportedName: string;
  localName: string | null;
  source: string | null;
  kind: string;
} {
  if (value.startsWith('reexportAlias:')) {
    try {
      const parsed = JSON.parse(value.slice('reexportAlias:'.length)) as {
        source?: string;
        importedName?: string;
        exportedName?: string;
      };
      return {
        exportedName: parsed.exportedName || value,
        localName: parsed.importedName || null,
        source: parsed.source || null,
        kind: 'reexport_alias',
      };
    } catch {}
  }
  if (value.startsWith('reexportNamespace:')) {
    try {
      const parsed = JSON.parse(value.slice('reexportNamespace:'.length)) as {
        source?: string;
        exportedName?: string;
      };
      return {
        exportedName: parsed.exportedName || value,
        localName: null,
        source: parsed.source || null,
        kind: 'reexport_namespace',
      };
    } catch {}
  }
  if (value.startsWith('reexport:')) {
    return {
      exportedName: '*',
      localName: null,
      source: value.slice('reexport:'.length),
      kind: 'reexport',
    };
  }
  return { exportedName: value, localName: value, source: null, kind: value === 'default' ? 'default' : 'named' };
}
