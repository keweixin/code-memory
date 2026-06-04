import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerGetContextPackTool } from '../src/mcp/tools/get-context-pack.js';
import { getContextLedgerEntries } from '../src/memory/context-ledger.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type ToolHandler = (args: Record<string, unknown>) => ToolResult;

interface ContextPackEnvelope {
  status: string;
  project: { root: string; repoName: string; dbPath: string };
  data: {
    contextPackId: string;
    sessionId: string;
    autoRecorded: boolean;
    repeatedContext: {
      omitted: boolean;
      totalPriorTokens: number;
      newFiles: number;
      repeatedFiles: number;
      newChunks: number;
      repeatedChunks: number;
      noveltyScore: number;
      repeatedPenalty: number;
    };
    trustContract: {
      confidence: string;
      allowedNextReads: Array<{
        path: string;
        lineRange?: string;
        reason: string;
        readPriority: string;
      }>;
      discouragedReads: Array<{ pattern: string; reason: string }>;
      exactSnippets: Array<{
        path: string;
        startLine: number;
        endLine: number;
        code: string;
        whyIncluded: string;
      }>;
      evidence: Array<{
        file: string | null;
        line: number | null;
        confidence: number;
        provenance: string;
      }>;
      relatedTests: Array<{ path: string; reason: string; confidence: number }>;
    };
  };
  display: string;
}

class FakeMcpServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: ToolHandler,
  ): void {
    this.handlers.set(name, handler);
  }
}

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'sample-ts-project',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
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

async function indexFixture(rootPath: string): Promise<void> {
  const config = createConfig(rootPath);
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(
    join(rootPath, '.code-memory', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
}

describe('MCP context pack ledger integration', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-context-pack-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('records context packs and can omit repeated snippets for a session', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetContextPackTool(server as never, getDatabaseSync());

    const first = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      sessionId: 'session-login',
      avoidRepeated: true,
    });
    const firstText = first.content[0].text;
    const firstStructured = JSON.parse(firstText) as ContextPackEnvelope;

    expect(firstText).toContain('=== Index Diagnostics ===');
    expect(firstText).toContain('Last indexed commit:');
    expect(firstText).toContain('=== Context Ledger ===');
    expect(firstText).toContain('=== Tool Trust Contract ===');
    expect(firstText).toContain('"exactSnippets"');
    expect(firstText).toContain('"code"');
    expect(firstText).toContain('Ledger entry:');
    expect(firstText).toContain('async login(request: LoginRequest)');
    expect(firstStructured.status).toBe('ready');
    expect(firstStructured.data.autoRecorded).toBe(true);
    expect(firstStructured.data.contextPackId).toBeTruthy();
    expect(firstStructured.data.sessionId).toBe('session-login');
    expect(firstStructured.data.repeatedContext.omitted).toBe(false);
    expect(firstStructured.data.trustContract.exactSnippets[0]).toMatchObject({
      path: expect.any(String),
      startLine: expect.any(Number),
      endLine: expect.any(Number),
      code: expect.any(String),
      whyIncluded: expect.any(String),
    });
    expect(firstStructured.data.trustContract.evidence[0]).toMatchObject({
      file: expect.any(String),
      line: expect.any(Number),
      confidence: expect.any(Number),
      provenance: expect.any(String),
    });
    expect(firstStructured.data.trustContract.allowedNextReads[0]).toMatchObject({
      path: expect.any(String),
      lineRange: expect.any(String),
      reason: expect.any(String),
      readPriority: expect.any(String),
    });
    expect(firstStructured.data.trustContract.allowedNextReads.length).toBeGreaterThan(0);
    for (const allowedRead of firstStructured.data.trustContract.allowedNextReads) {
      expect(allowedRead.path).toMatch(/\.(ts|tsx|js|jsx|py)$/);
      expect(allowedRead.reason.length).toBeGreaterThan(10);
      expect(['high', 'medium', 'low']).toContain(allowedRead.readPriority);
    }
    expect(firstStructured.data.trustContract.discouragedReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern: expect.stringMatching(/Grep|Glob|whole repo/i),
          reason: expect.any(String),
        }),
      ]),
    );

    const second = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      sessionId: 'session-login',
      avoidRepeated: true,
    });
    const secondText = second.content[0].text;
    const secondStructured = JSON.parse(secondText) as ContextPackEnvelope;

    expect(secondText).toContain('Repeated chunks:');
    expect(secondText).toContain('Repeated context omitted for session session-login.');
    expect(secondText).toContain('Fill-after-omit used 60 ranked candidates');
    expect(secondText).not.toContain('async login(request: LoginRequest)');
    expect(secondStructured.data.autoRecorded).toBe(true);
    expect(secondStructured.data.sessionId).toBe('session-login');
    expect(secondStructured.data.repeatedContext.omitted).toBe(true);
    expect(secondStructured.data.repeatedContext.repeatedChunks).toBeGreaterThan(0);
    expect(secondStructured.data.repeatedContext.repeatedFiles).toBeGreaterThan(0);
    expect(secondStructured.data.repeatedContext.newChunks).toBeLessThan(firstStructured.data.trustContract.exactSnippets.length + secondStructured.data.repeatedContext.repeatedChunks);
    expect(secondStructured.data.repeatedContext.repeatedPenalty).toBeGreaterThanOrEqual(0.5);
    const entries = getContextLedgerEntries('session-login');
    expect(entries).toHaveLength(2);
    const firstEntry = entries[0]!;
    const secondEntry = entries[1]!;
    const repeatedFileOverlap = firstEntry.returnedFiles
      .filter((file) => secondEntry.returnedFiles.includes(file)).length;
    const repeatedChunkOverlap = firstEntry.returnedChunks
      .filter((chunk) => secondEntry.returnedChunks.includes(chunk)).length;
    const repeatedFileReduction = firstEntry.returnedFiles.length === 0
      ? 1
      : 1 - repeatedFileOverlap / firstEntry.returnedFiles.length;
    const repeatedChunkReduction = firstEntry.returnedChunks.length === 0
      ? 1
      : 1 - repeatedChunkOverlap / firstEntry.returnedChunks.length;
    const usefulDeltaRate = secondEntry.returnedFiles.length > 0 || secondEntry.returnedChunks.length > 0 ? 1 : 0;
    const overPruningRate = secondEntry.returnedFiles.length === 0 && secondEntry.returnedChunks.length === 0 ? 1 : 0;
    expect(repeatedFileReduction).toBeGreaterThanOrEqual(0.5);
    expect(repeatedChunkReduction).toBeGreaterThanOrEqual(0.6);
    expect(usefulDeltaRate).toBeGreaterThanOrEqual(0.8);
    expect(overPruningRate).toBeLessThanOrEqual(0.1);
  });

  it('auto-records a context pack when callers omit sessionId and returns the generated session identity', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetContextPackTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      levels: 'L4',
    });
    const structured = JSON.parse(result.content[0].text) as ContextPackEnvelope;

    expect(structured.data.autoRecorded).toBe(true);
    expect(structured.data.contextPackId).toBeTruthy();
    expect(structured.data.sessionId).toMatch(/^auto-/);
    expect(getContextLedgerEntries(structured.data.sessionId)).toHaveLength(1);
  });

  it('fills with new code snippets after omitting lower-level repeated context', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetContextPackTool(server as never, getDatabaseSync());

    const first = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 2000,
      sessionId: 'session-login-fill',
      avoidRepeated: true,
    });
    const firstText = first.content[0].text;
    const firstStructured = JSON.parse(firstText) as ContextPackEnvelope;

    expect(firstText).toContain('New symbols:');
    expect(firstText).not.toContain('=== Code ===');
    expect(firstStructured.data.repeatedContext.omitted).toBe(false);

    const second = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      sessionId: 'session-login-fill',
      avoidRepeated: true,
    });
    const secondText = second.content[0].text;
    const secondStructured = JSON.parse(secondText) as ContextPackEnvelope;

    expect(secondText).toContain('Repeated symbols:');
    expect(secondText).toContain('New chunks:');
    expect(secondText).toContain('Repeated context omitted for session session-login-fill.');
    expect(secondText).toContain('Fill-after-omit used 60 ranked candidates');
    expect(secondText).toContain('=== Code ===');
    expect(secondText).toContain('async function issueTokens(payload: TokenPayload): Promise<TokenPair>');
    expect(secondStructured.data.repeatedContext.omitted).toBe(true);
    expect(secondStructured.data.repeatedContext.repeatedFiles).toBeGreaterThan(0);
  });

  it('honors the requested maximum context detail level', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetContextPackTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      levels: 'L2',
    });
    const text = result.content[0].text;
    const structured = JSON.parse(text) as ContextPackEnvelope;

    expect(text).toContain('=== Symbols ===');
    expect(text).not.toContain('=== Code ===');
    expect(text).not.toContain('const user = await findUserByEmail(request.email);');
    expect(text).toContain('[Context: level=L2,');
    expect(structured.data.trustContract.exactSnippets).toHaveLength(0);
    expect(structured.data.trustContract.allowedNextReads[0].path).toBeTruthy();
  });
});
