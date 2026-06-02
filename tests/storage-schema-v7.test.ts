import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeDatabase,
  getDatabase,
  getDatabaseSync,
  needsReindex,
} from '../src/storage/database.js';
import { SCHEMA_VERSION } from '../src/storage/schema.js';

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

function querySingle(sql: string, params: unknown[] = []): unknown {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values?.[0]?.[0];
}

function tableExists(table: string): boolean {
  const rows = queryRows(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1",
    [table],
  );
  return rows.length > 0;
}

function getColumns(table: string): string[] {
  const rows = queryRows(`PRAGMA table_info(${table})`);
  return rows.map((row) => String(row[1]));
}

describe('storage schema v7 (processes and communities)', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-schema-v7-'));
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    await getDatabase(tempRoot);
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('exposes SCHEMA_VERSION = 7', () => {
    expect(SCHEMA_VERSION).toBe(7);
  });

  it('creates the four new process and community tables', () => {
    expect(tableExists('processes')).toBe(true);
    expect(tableExists('process_steps')).toBe(true);
    expect(tableExists('communities')).toBe(true);
    expect(tableExists('community_members')).toBe(true);
  });

  it('defines the expected columns on the new tables', () => {
    const processesCols = getColumns('processes');
    expect(processesCols).toEqual(expect.arrayContaining([
      'id', 'name', 'entry_point', 'entry_kind', 'framework',
      'depth_limit', 'step_count', 'last_indexed', 'created_at',
    ]));

    const processStepsCols = getColumns('process_steps');
    expect(processStepsCols).toEqual(expect.arrayContaining([
      'id', 'process_id', 'step', 'symbol_id', 'file_id', 'edge_id', 'label',
    ]));

    const communitiesCols = getColumns('communities');
    expect(communitiesCols).toEqual(expect.arrayContaining([
      'id', 'name', 'cohesion', 'symbol_count', 'keywords',
      'detection_method', 'top_entry_symbols', 'last_indexed', 'created_at',
    ]));

    const communityMembersCols = getColumns('community_members');
    expect(communityMembersCols).toEqual(expect.arrayContaining([
      'id', 'community_id', 'symbol_id', 'file_id', 'weight',
    ]));
  });

  it('creates the supporting indexes for the new tables', () => {
    const indexes = queryRows(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_process%' OR name LIKE 'idx_communit%')",
    ).map((row) => String(row[0]));

    expect(indexes).toEqual(expect.arrayContaining([
      'idx_processes_name',
      'idx_process_steps_process_id',
      'idx_process_steps_step',
      'idx_communities_name',
      'idx_community_members_community',
      'idx_community_members_symbol',
    ]));
  });

  it('allows inserting a process and a step referencing it', () => {
    const db = getDatabaseSync();

    db.run(
      `INSERT INTO processes (id, name, entry_point, framework, depth_limit, created_at)
       VALUES ('proc-1', 'Login flow', 'POST /api/login', 'express', 8, '2026-06-02T00:00:00Z')`,
    );

    db.run(
      `INSERT INTO process_steps (id, process_id, step, symbol_id, label)
       VALUES ('step-1', 'proc-1', 0, 'sym-a', 'authenticate')`,
    );

    expect(String(querySingle("SELECT name FROM processes WHERE id = 'proc-1'"))).toBe('Login flow');
    expect(String(querySingle("SELECT entry_point FROM processes WHERE id = 'proc-1'"))).toBe('POST /api/login');
    expect(String(querySingle("SELECT framework FROM processes WHERE id = 'proc-1'"))).toBe('express');
    expect(Number(querySingle("SELECT depth_limit FROM processes WHERE id = 'proc-1'"))).toBe(8);

    expect(String(querySingle("SELECT process_id FROM process_steps WHERE id = 'step-1'"))).toBe('proc-1');
    expect(Number(querySingle("SELECT step FROM process_steps WHERE id = 'step-1'"))).toBe(0);
    expect(String(querySingle("SELECT label FROM process_steps WHERE id = 'step-1'"))).toBe('authenticate');
  });

  it('cascade deletes process_steps when the parent process is removed', () => {
    const db = getDatabaseSync();

    db.run(
      `INSERT INTO processes (id, name, entry_point, created_at)
       VALUES ('proc-cascade', 'Cascade flow', 'GET /api/x', '2026-06-02T00:00:00Z')`,
    );
    db.run(
      `INSERT INTO process_steps (id, process_id, step, label)
       VALUES
         ('cs-1', 'proc-cascade', 0, 'a'),
         ('cs-2', 'proc-cascade', 1, 'b')`,
    );

    expect(Number(querySingle("SELECT COUNT(*) FROM process_steps WHERE process_id = 'proc-cascade'"))).toBe(2);

    db.run("DELETE FROM processes WHERE id = 'proc-cascade'");

    expect(tableExists('processes')).toBe(true);
    expect(Number(querySingle("SELECT COUNT(*) FROM process_steps WHERE process_id = 'proc-cascade'"))).toBe(0);
  });

  it('persists default values for entry_kind, depth_limit, step_count, detection_method, keywords, top_entry_symbols, and weight', () => {
    const db = getDatabaseSync();

    db.run(
      `INSERT INTO processes (id, name, entry_point) VALUES ('proc-defaults', 'Defaults', '/api/x')`,
    );
    db.run(
      `INSERT INTO communities (id, name) VALUES ('comm-1', 'cluster-1')`,
    );
    db.run(
      `INSERT INTO community_members (id, community_id, symbol_id) VALUES ('cm-1', 'comm-1', 'sym-1')`,
    );

    expect(String(querySingle("SELECT entry_kind FROM processes WHERE id = 'proc-defaults'"))).toBe('route');
    expect(Number(querySingle("SELECT depth_limit FROM processes WHERE id = 'proc-defaults'"))).toBe(10);
    expect(Number(querySingle("SELECT step_count FROM processes WHERE id = 'proc-defaults'"))).toBe(0);

    expect(String(querySingle("SELECT detection_method FROM communities WHERE id = 'comm-1'"))).toBe('louvain');
    expect(String(querySingle("SELECT keywords FROM communities WHERE id = 'comm-1'"))).toBe('[]');
    expect(String(querySingle("SELECT top_entry_symbols FROM communities WHERE id = 'comm-1'"))).toBe('[]');
    expect(Number(querySingle("SELECT cohesion FROM communities WHERE id = 'comm-1'"))).toBe(0);
    expect(Number(querySingle("SELECT symbol_count FROM communities WHERE id = 'comm-1'"))).toBe(0);

    expect(Number(querySingle("SELECT weight FROM community_members WHERE id = 'cm-1'"))).toBe(1);
  });

  it('records schema_version metadata equal to SCHEMA_VERSION', () => {
    expect(String(querySingle("SELECT value FROM index_metadata WHERE key = 'schema_version'"))).toBe(String(SCHEMA_VERSION));
  });

  it('considers a v6 database stale (needsReindex returns true when schema_version=6)', () => {
    const db = getDatabaseSync();
    db.run("UPDATE index_metadata SET value = '6' WHERE key = 'schema_version'");

    expect(needsReindex()).toBe(true);
  });
});
