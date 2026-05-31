/**
 * Parse metadata persistence. These tables are the second-stage graph
 * builder's source of truth, so edge rebuilding never needs to read files.
 */

import type {
  CallReference,
  ImportInfo,
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

export function deleteParseMetadataByFileId(fileId: string): void {
  const db = getDatabaseSync();
  for (const table of ['file_imports', 'file_exports', 'call_refs', 'scope_bindings', 'type_relations']) {
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
}): void {
  const db = getDatabaseSync();
  deleteParseMetadataByFileId(params.fileId);

  for (const imp of params.imports) {
    const entries = materializeImportEntries(params.fileId, imp);
    for (const entry of entries) {
      db.run(
        `INSERT OR REPLACE INTO file_imports
          (id, file_id, source, imported_name, local_name, kind, is_type_only, start_line, start_column)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          params.fileId,
          imp.source,
          entry.importedName,
          entry.localName,
          entry.kind,
          imp.isTypeOnly ? 1 : 0,
          imp.startLine ?? 0,
          imp.startColumn ?? 0,
        ],
      );
    }
  }

  params.exports.forEach((exportedName, index) => {
    const parsed = parseExportMetadata(exportedName);
    db.run(
      `INSERT OR REPLACE INTO file_exports
        (id, file_id, exported_name, local_name, source, kind, start_line, start_column)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId('file_export', params.fileId, String(index), exportedName),
        params.fileId,
        parsed.exportedName,
        parsed.localName,
        parsed.source,
        parsed.kind,
        0,
        0,
      ],
    );
  });

  params.calls.forEach((call, index) => {
    db.run(
      `INSERT OR REPLACE INTO call_refs
        (id, file_id, caller_symbol_id, caller_name, caller_start_line, caller_class_name,
         callee_name, receiver_name, receiver_kind, member_name, is_constructor_call,
         start_line, start_column, evidence, resolution_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    );
  });

  params.scopeBindings.forEach((binding, index) => {
    db.run(
      `INSERT OR REPLACE INTO scope_bindings
        (id, file_id, symbol_id, local_name, binding_kind, target_name, target_symbol_id, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId('scope_binding', params.fileId, String(index), binding.localName, String(binding.startLine)),
        params.fileId,
        binding.symbolId,
        binding.localName,
        binding.bindingKind,
        binding.targetName,
        binding.targetSymbolId,
        binding.startLine,
        binding.endLine,
      ],
    );
  });

  params.typeRelations.forEach((relation, index) => {
    db.run(
      `INSERT OR REPLACE INTO type_relations
        (id, file_id, from_symbol_id, relation_kind, target_name, target_symbol_id, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId('type_relation', params.fileId, String(index), relation.relationKind, relation.targetName),
        params.fileId,
        relation.fromSymbolId,
        relation.relationKind,
        relation.targetName,
        relation.targetSymbolId,
        relation.evidence,
      ],
    );
  });
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
