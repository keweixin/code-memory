/**
 * Code Memory Graph — Constants
 */

// Version
export const VERSION = '0.3.5';

// Published npm package spec used by generated npx commands.
export const NPM_PACKAGE_SPEC = '@keweixin/code-memory@latest';

// Default config directory name
export const CONFIG_DIR = '.code-memory';

// Default config file name
export const CONFIG_FILE = 'config.json';

// Default database file name
export const DATABASE_FILE = 'index.db';

// Default vectors directory name
export const VECTORS_DIR = 'vectors';

// Default summaries directory name
export const SUMMARIES_DIR = 'summaries';

// Default memories directory name
export const MEMORIES_DIR = 'memories';

// RRF constant (standard value from information retrieval literature)
export const RRF_K = 60;

// Default search weights for hybrid retrieval
export const DEFAULT_VECTOR_WEIGHT = 0.30;
export const DEFAULT_KEYWORD_WEIGHT = 0.20;
export const DEFAULT_GRAPH_WEIGHT = 0.25;
export const DEFAULT_INTENT_WEIGHT = 0.15;
export const DEFAULT_NOVELTY_WEIGHT = 0.10;

// Default search limits
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

// Default graph traversal depths
export const DEFAULT_GRAPH_HOPS = 2;
export const MAX_GRAPH_HOPS = 5;

// Embedding dimensions (depends on model)
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;  // all-MiniLM-L6-v2
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;   // text-embedding-3-small

// File size thresholds
export const LARGE_FILE_THRESHOLD = 100_000;       // 100KB - only structural summary
export const HUGE_FILE_THRESHOLD = 500_000;        // 500KB - skip embedding
export const MAX_FILE_THRESHOLD = 1_000_000;       // 1MB - only metadata

// Debounce timing
export const DEFAULT_DEBOUNCE_MS = 500;
export const MAX_WATCH_BATCH_MS = 2000;

// Language to file extension mapping
export const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py', '.pyi', '.pyw'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.hpp', '.cc', '.cxx', '.hxx'],
  csharp: ['.cs'],
  ruby: ['.rb', '.rake'],
  php: ['.php'],
  swift: ['.swift'],
  kotlin: ['.kt', '.kts'],
};

// Extension to language reverse mapping
export const EXTENSION_TO_LANGUAGE: Record<string, string> = Object.entries(LANGUAGE_EXTENSIONS)
  .flatMap(([lang, exts]) => exts.map(ext => [ext, lang]))
  .reduce((acc, [ext, lang]) => {
    (acc as Record<string, string>)[ext as string] = lang as string;
    return acc;
  }, {} as Record<string, string>);

// Default ignore patterns
export const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.svn',
  '.hg',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  '.tox',
  'target',
  'bin',
  'obj',
  '*.lock',
  '*.min.js',
  '*.min.css',
  '*.gen.ts',
  '*.gen.js',
  '*.pb.go',
  '*.pyc',
  '*.pyo',
  '*.so',
  '*.dll',
  '*.dylib',
  '*.exe',
  '*.wasm',
  '.DS_Store',
  'Thumbs.db',
  '.code-memory',
];

// Test file patterns (for role detection)
export const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.test\.py$/,
  /_test\.go$/,
  /_test\.rs$/,
  /Test\.cs$/,
  /_test\.java$/,
  /tests?\//i,
  /__tests__\//,
  /spec\//i,
];

// Config file patterns (for role detection)
export const CONFIG_FILE_PATTERNS = [
  /\.json$/,
  /\.yaml$/,
  /\.yml$/,
  /\.toml$/,
  /\.ini$/,
  /\.env/,
  /^\.editorconfig$/,
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^tsconfig/,
  /^jsconfig/,
  /^webpack\.config/,
  /^vite\.config/,
  /^rollup\.config/,
  /^jest\.config/,
  /^vitest\.config/,
  /^Dockerfile/,
  /^docker-compose/,
  /^Makefile$/,
  /^Cargo\.toml$/,
  /^go\.mod$/,
  /^pyproject\.toml$/,
  /^setup\.(cfg|py)$/,
  /^requirements\.txt$/,
];

// Doc file patterns (for role detection)
export const DOC_FILE_PATTERNS = [
  /\.md$/,
  /\.rst$/,
  /\.adoc$/,
  /\.txt$/,
  /^README/i,
  /^CHANGELOG/i,
  /^CONTRIBUTING/i,
  /^LICENSE/i,
  /^CODE_OF_CONDUCT/i,
  /^ADR/i,
];

// Risk level keywords for file risk detection
export const HIGH_RISK_PATTERNS = [
  /auth/i,
  /password/i,
  /secret/i,
  /token/i,
  /crypto/i,
  /encrypt/i,
  /permission/i,
  /security/i,
  /middleware/i,
  /guard/i,
  /interceptor/i,
];

// SQLite pragmas for performance
export const SQLITE_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA cache_size = -64000',      // 64MB
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY',
];
