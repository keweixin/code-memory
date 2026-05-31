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
  isTypeOnly: boolean;      // TypeScript type-only imports
  isDefault: boolean;       // Default import
}

export interface SymbolRecord {
  id: string;
  fileId: string;
  name: string;
  kind: SymbolKind;
  rangeStart: number;
  rangeEnd: number;
  signature: string | null;
  summary: string | null;
  hash: string;
  accessLevel: AccessLevel | null;
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
}

export type ContextFeedback = 'useful' | 'irrelevant' | 'stale';

export interface ContextLedgerEntry {
  id: string;
  sessionId: string;
  query: string;
  returnedFiles: string[];
  returnedSymbols: string[];
  returnedChunks: string[];
  tokenEstimate: number;
  evidenceIds: string[];
  agentFeedback: ContextFeedback | null;
  createdAt: string;
}

export interface ContextDelta {
  newFiles: string[];
  repeatedFiles: string[];
  newSymbols: string[];
  repeatedSymbols: string[];
  newChunks: string[];
  repeatedChunks: string[];
  totalPriorTokens: number;
  evidenceIds: string[];
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

export interface SearchResult {
  id: string;
  name: string;
  kind: SymbolKind | 'file';
  filePath: string;
  score: number;
  sources: SearchSource[];
  snippet: string | null;
  lineRange: [number, number] | null;
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
}

export interface SearchWeights {
  vector: number;
  keyword: number;
  graph: number;
}

export const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
  vector: 0.50,
  keyword: 0.30,
  graph: 0.20,
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
}

export interface ProjectCard {
  name: string;
  languages: Language[];
  totalFiles: number;
  totalSymbols: number;
  architectureStyle: string | null;
  framework: string | null;
  rootPath: string;
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
  reason: string;
}

export interface ContextSnippet {
  filePath: string;
  symbolName: string | null;
  content: string;
  lineRange: [number, number];
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
  symbols: SymbolRecord[];
  imports: ImportInfo[];
  exports: string[];
  edges: EdgeRecord[];
  calls: CallReference[];
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
  calleeName: string;
  rangeStart: number;
  rangeEnd: number;
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
