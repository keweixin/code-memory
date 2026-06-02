/**
 * Code Memory Graph — Global Type Definitions
 *
 * All shared types, enums, and interfaces used across the system.
 */

// ============================================================
// Enums
// ============================================================

export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'unknown';

export type FileRole =
  | 'source'
  | 'test'
  | 'config'
  | 'doc'
  | 'asset'
  | 'generated'
  | 'lock'
  | 'build';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'property'
  | 'constructor'
  | 'module'
  | 'namespace'
  | 'component'
  | 'hook'
  | 'route'
  | 'api_endpoint';

export type EdgeType =
  | 'IMPORTS'
  | 'EXPORTS_TO'
  | 'CALLS'
  | 'DEFINES'
  | 'CONTAINS'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'REFERENCES'
  | 'RETURNS'
  | 'THROWS'
  | 'USES_TYPE'
  | 'TESTS'
  | 'DOCUMENTS'
  | 'CONFIGURES'
  | 'ROUTE_ENDPOINT'
  | 'ROUTE_REFERENCES'
  | 'GENERATES';

export type MemoryType =
  | 'repo'
  | 'session'
  | 'branch'
  | 'decision'
  | 'user_preference';

export type ContextLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type AccessLevel = 'public' | 'private' | 'protected' | 'internal';

// ============================================================
// Core Records
// ============================================================

export interface FileRecord {
  id: string;
  path: string;
  language: Language;
  role: FileRole;
  size: number;
  hash: string;
  indexedAt: string;
  lastCommit: string | null;
  isGenerated: boolean;
  isIgnored: boolean;
  exports: string[];
  imports: ImportInfo[];
  summary: string | null;
  riskLevel: RiskLevel;
}

export interface ImportInfo {
  source: string;           // Module path or package name
  names: string[];          // Imported symbol names
  aliases?: Record<string, string>; // Local imported name -> exported symbol name
  isTypeOnly: boolean;      // TypeScript type-only imports
  isDefault: boolean;       // Default import
  defaultName?: string;     // Local name for the default import binding
  isNamespace?: boolean;    // import * as ns from '...'
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

export interface SymbolRecord {
  id: string;
  fileId: string;
  name: string;
  kind: SymbolKind;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  /** @deprecated Compatibility alias for startLine; never a byte offset. */
  rangeStart: number;
  /** @deprecated Compatibility alias for endLine; never a byte offset. */
  rangeEnd: number;
  signature: string | null;
  summary: string | null;
  hash: string;
  accessLevel: AccessLevel | null;
  searchText?: string;
}

export interface EdgeRecord {
  id: string;
  fromId: string;
  toId: string;
  type: EdgeType;
  confidence: number;
  evidence: string | null;
}

export interface ChunkRecord {
  id: string;
  fileId: string;
  symbolId: string | null;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  contentHash: string;
  content: string;
  tokenCount: number;
  summary: string | null;
  embeddingId: string | null;
}

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  scope: string[];
  evidence: string[];
  confidence: number;
  createdCommit: string | null;
  lastValidatedCommit: string | null;
  invalidationRules: InvalidationRule[];
  createdAt: string;
  updatedAt: string;
  stale?: boolean;
  staleReason?: string;
  relevanceScore?: number;
}

export type ContextFeedback = 'useful' | 'irrelevant' | 'stale';

export interface ContextLedgerEntry {
  id: string;
  sessionId: string;
  taskId: string | null;
  repoRoot: string | null;
  branch: string | null;
  commit: string | null;
  query: string;
  returnedFiles: string[];
  returnedSymbols: string[];
  returnedChunks: string[];
  tokenEstimate: number;
  evidenceIds: string[];
  evidenceFingerprints: string[];
  noveltyScore: number;
  repeatedPenalty: number;
  agentFeedback: ContextFeedback | null;
  feedbackReason: string | null;
  createdAt: string;
}

export interface ContextDelta {
  newFiles: string[];
  repeatedFiles: string[];
  newSymbols: string[];
  repeatedSymbols: string[];
  newChunks: string[];
  repeatedChunks: string[];
  newEvidenceIds: string[];
  repeatedEvidenceIds: string[];
  totalPriorTokens: number;
  evidenceIds: string[];
  noveltyScore: number;
  repeatedPenalty: number;
}

// ============================================================
// Invalidation
// ============================================================

export interface InvalidationRule {
  type: 'file_change' | 'symbol_change' | 'commit' | 'time';
  target: string;           // File glob, symbol name, commit hash, or ISO duration
  description: string;
}

// ============================================================
// Search
// ============================================================

export type EvidenceKind =
  | 'ast_node'
  | 'import_clause'
  | 'call_expr'
  | 'route_literal'
  | 'test_name'
  | 'config'
  | 'memory'
  | 'ledger';

export type SearchIntent =
  | 'debug'
  | 'refactor'
  | 'add_test'
  | 'explain'
  | 'route'
  | 'security'
  | 'general';

export interface IntentClassification {
  intent: SearchIntent;
  matchedHints: string[];
  source: 'explicit' | 'inferred' | 'default';
}

export interface GraphEdgeProfile {
  name: SearchIntent;
  direction: 'outgoing' | 'incoming' | 'both';
  edgeTypes: EdgeType[];
  effectiveEdgeTypes?: EdgeType[];
}

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  contentHash?: string;
  preview?: string;
  confidence: number;
}

export interface ScoreBreakdown {
  keywordRank?: number;
  vectorRank?: number;
  graphRank?: number;
  rrfKeyword?: number;
  rrfVector?: number;
  rrfGraph?: number;
  keyword?: number;
  vector?: number;
  graph?: number;
  route?: number;
  test?: number;
  memory?: number;
  freshness?: number;
  evidence?: number;
  ledgerPenalty?: number;
  finalScore?: number;
}

export interface ToolDiagnostics {
  schemaVersion: number;
  indexCommit?: string;
  vectorUsed: boolean;
  graphUsed: boolean;
  repeatedContextOmitted: number;
  repeatedContextPenalized?: number;
  totalPriorContextTokens?: number;
  staleIndex?: boolean;
  intent?: SearchIntent;
  intentHints?: string[];
  graphProfile?: GraphEdgeProfile;
}

export const TOOL_ERROR_CODES = [
  'INDEX_MISSING',
  'VECTOR_UNAVAILABLE',
  'QUERY_TOO_BROAD',
  'NO_RESULTS',
  'STALE_INDEX',
  'SCHEMA_MISMATCH',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolSuccessEnvelope<T> {
  ok: true;
  data: T;
  diagnostics: ToolDiagnostics;
}

export interface ToolErrorEnvelope {
  ok: false;
  error: {
    code: ToolErrorCode;
    message: string;
    details?: unknown;
  };
  diagnostics?: ToolDiagnostics;
}

export interface SearchResult {
  id: string;
  name: string;
  kind: SymbolKind | 'file';
  filePath: string;
  score: number;
  sources: SearchSource[];
  snippet: string | null;
  lineRange: [number, number] | null;
  columnRange: [number, number] | null;
  evidence?: EvidenceItem[];
  scoreBreakdown?: ScoreBreakdown;
  diagnostics?: ToolDiagnostics;
}

export type SearchSource = 'vector' | 'keyword' | 'graph';

export interface SearchOptions {
  query: string;
  limit?: number;
  kindFilter?: SymbolKind;
  fileFilter?: string;
  searchMode?: 'hybrid' | 'keyword' | 'vector' | 'graph';
  weights?: SearchWeights;
  graphHops?: number;
  intent?: SearchIntent;
  sessionId?: string;
  avoidRepeated?: boolean;
}

export interface SearchWeights {
  vector: number;
  keyword: number;
  graph: number;
  intent?: number;
  novelty?: number;
}

export const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
  vector: 0.30,
  keyword: 0.20,
  graph: 0.25,
  intent: 0.15,
  novelty: 0.10,
};

// ============================================================
// Context Pack
// ============================================================

export interface ContextPack {
  query: string;
  tokenBudget: number;
  tokensUsed: number;
  level: ContextLevel;
  projectCard: ProjectCard | null;
  relevantMemories: MemoryRecord[];
  files: ContextFile[];
  symbols: ContextSymbol[];
  codeSnippets: ContextSnippet[];
  callChains: string[];
  missing: string[];
  evidence?: EvidenceItem[];
  diagnostics?: ToolDiagnostics;
}

export interface ProjectCard {
  name: string;
  languages: Language[];
  totalFiles: number;
  totalSymbols: number;
  architectureStyle: string | null;
  framework: string | null;
  rootPath: string;
  currentCommit: string | null;
  currentBranch: string | null;
  indexCompleted: string | null;
  vectorSearch: 'disabled' | 'pending_index' | 'enabled';
}

export interface ContextFile {
  path: string;
  role: FileRole;
  language: Language;
  reason: string;
  confidence: number;
}

export interface ContextSymbol {
  name: string;
  kind: SymbolKind;
  filePath: string;
  signature: string | null;
  summary: string | null;
  lineRange: [number, number];
  columnRange: [number, number];
  reason: string;
}

export interface ContextSnippet {
  filePath: string;
  symbolName: string | null;
  content: string;
  lineRange: [number, number];
  columnRange: [number, number];
  tokenCount: number;
  reason: string;
}

// ============================================================
// Impact Analysis
// ============================================================

export interface ImpactResult {
  target: string;
  affectedFiles: ImpactFile[];
  affectedSymbols: ImpactSymbol[];
  relatedTests: string[];
  relatedConfigs: string[];
  riskPoints: RiskPoint[];
  callChain: string[];
}

export interface ImpactFile {
  path: string;
  impactType: 'direct' | 'indirect';
  distance: number;
  reason: string;
}

export interface ImpactSymbol {
  name: string;
  kind: SymbolKind;
  filePath: string;
  impactType: 'caller' | 'callee' | 'implementor' | 'reference';
  distance: number;
}

export interface RiskPoint {
  description: string;
  severity: RiskLevel;
  filePath: string;
  symbolName: string | null;
}

// ============================================================
// Index Metadata
// ============================================================

export interface IndexStatus {
  projectPath: string;
  totalFiles: number;
  indexedFiles: number;
  totalSymbols: number;
  totalEdges: number;
  totalChunks: number;
  totalMemories: number;
  lastFullIndex: string | null;
  lastIncrementalIndex: string | null;
  currentCommit: string | null;
  currentBranch: string | null;
  embeddingProvider: string | null;
  isIndexing: boolean;
}

// ============================================================
// Config
// ============================================================

export interface CodeMemoryConfig {
  projectName: string;
  rootPath: string;
  ignore: string[];
  languages: Language[];
  embedding: EmbeddingConfig;
  indexing?: IndexingConfig;
  llm: LlmConfig | null;
  realtime: RealtimeConfig;
  tokenBudgets: TokenBudgets;
}

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai' | 'none';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
  batchSize?: number;
  concurrency?: number;
}

export interface IndexingConfig {
  workers?: 'auto' | number;
  parseBatchSize?: number;
  edgeMode?: 'full' | 'dirty';
}

export interface LlmConfig {
  provider: 'ollama' | 'openai' | 'openai-compatible';
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface RealtimeConfig {
  watch: boolean;
  debounceMs: number;
}

export interface TokenBudgets {
  L0: number;
  L1: number;
  L2: number;
  L3: number;
  L4: number;
}

export const DEFAULT_TOKEN_BUDGETS: TokenBudgets = {
  L0: 500,
  L1: 1500,
  L2: 3000,
  L3: 6000,
  L4: 12000,
};

// ============================================================
// Parse Results (from Tree-sitter)
// ============================================================

export interface ParseResult {
  fileId: string;
  filePath: string;
  language: Language;
  /** Full SHA-256 hash of the source content used to create this parse result. */
  contentHash: string;
  symbols: SymbolRecord[];
  imports: ImportInfo[];
  exports: string[];
  edges: EdgeRecord[];
  calls: CallReference[];
  scopeBindings: ScopeBindingRecord[];
  typeRelations: TypeRelationRecord[];
  routeEndpoints: RouteEndpointRecord[];
  routeReferences: RouteReferenceRecord[];
  chunks: ChunkRecord[];
  errors: ParseError[];
}

export interface ParseError {
  filePath: string;
  line: number | null;
  message: string;
  severity: 'error' | 'warning';
}

export interface CallReference {
  callerName: string | null;
  callerStartLine: number | null;
  callerClassName?: string | null;
  callerSymbolId?: string | null;
  calleeName: string;
  receiverName?: string | null;
  receiverKind?: 'this' | 'identifier' | 'namespace' | 'constructor' | 'unknown' | null;
  memberName?: string | null;
  isConstructorCall?: boolean;
  /** 1-based line where the call expression starts; never a byte offset. */
  rangeStart: number;
  /** 1-based line where the call expression ends; never a byte offset. */
  rangeEnd: number;
  /** 0-based UTF-16 column where the call expression starts. */
  startColumn?: number;
  evidence: string;
}

export interface ScopeBindingRecord {
  fileId: string;
  symbolId: string | null;
  localName: string;
  bindingKind: 'constructor' | 'import' | 'alias' | 'unknown';
  targetName: string | null;
  targetSymbolId: string | null;
  startLine: number;
  endLine: number;
}

export interface TypeRelationRecord {
  fileId: string;
  fromSymbolId: string | null;
  relationKind: 'EXTENDS' | 'IMPLEMENTS';
  targetName: string;
  targetSymbolId: string | null;
  evidence: string;
}

export interface RouteEndpointRecord {
  fileId: string;
  symbolId: string | null;
  routePath: string;
  httpMethod: string;
  framework: 'next_app_router' | 'fastapi';
  startLine: number;
  startColumn: number;
  evidence: string;
}

export interface RouteReferenceRecord {
  fileId: string;
  callerSymbolId: string | null;
  routePath: string;
  httpMethod: string | null;
  framework: 'fetch';
  startLine: number;
  startColumn: number;
  evidence: string;
}

// ============================================================
// Graph
// ============================================================

export interface GraphNode {
  id: string;
  type: 'file' | 'symbol';
  label: string;
  kind: SymbolKind | FileRole;
  filePath: string | null;
  lineRange: [number, number] | null;
  columnRange: [number, number] | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  confidence: number;
}

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalWeight: number;
}
