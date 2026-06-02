/**
 * Code Memory Graph — Parser-Specific Types
 *
 * Types used during the parsing and extraction phase,
 * before records are persisted to the database.
 */

import type {
  Language,
  SymbolKind,
  AccessLevel,
  ImportInfo,
} from '../shared/types.js';

// ============================================================
// Parser Language
// ============================================================

/**
 * Granular language identifiers for the parser layer.
 *
 * Extends the shared `Language` type with TSX and JSX distinctions,
 * since tree-sitter uses separate grammar WASM files for these.
 */
export enum ParserLanguage {
  TypeScript = 'typescript',
  TSX = 'tsx',
  JavaScript = 'javascript',
  JSX = 'jsx',
  Python = 'python',
  Go = 'go',
}

/**
 * Mapping from ParserLanguage to the shared Language type.
 * TSX maps to 'typescript', JSX maps to 'javascript'.
 */
export const PARSER_LANGUAGE_TO_LANGUAGE: Record<ParserLanguage, Language> = {
  [ParserLanguage.TypeScript]: 'typescript',
  [ParserLanguage.TSX]: 'typescript',
  [ParserLanguage.JavaScript]: 'javascript',
  [ParserLanguage.JSX]: 'javascript',
  [ParserLanguage.Python]: 'python',
  [ParserLanguage.Go]: 'go',
};

/**
 * File extension to ParserLanguage mapping.
 * Extensions not listed here are unsupported.
 */
export const EXTENSION_TO_PARSER_LANGUAGE: Record<string, ParserLanguage> = {
  '.ts': ParserLanguage.TypeScript,
  '.mts': ParserLanguage.TypeScript,
  '.cts': ParserLanguage.TypeScript,
  '.tsx': ParserLanguage.TSX,
  '.js': ParserLanguage.JavaScript,
  '.mjs': ParserLanguage.JavaScript,
  '.cjs': ParserLanguage.JavaScript,
  '.jsx': ParserLanguage.JSX,
  '.py': ParserLanguage.Python,
  '.pyi': ParserLanguage.Python,
  '.pyw': ParserLanguage.Python,
  '.go': ParserLanguage.Go,
};

// ============================================================
// Language Configuration
// ============================================================

/**
 * Configuration for a single parser language.
 * Describes how to locate and load the tree-sitter grammar WASM.
 */
export interface LanguageConfig {
  /** Human-readable name */
  name: string;
  /** ParserLanguage enum value */
  parserLanguage: ParserLanguage;
  /** WASM filename (e.g. 'tree-sitter-typescript.wasm') */
  wasmFile: string;
  /** File extensions this language handles */
  extensions: string[];
}

/**
 * Full configuration for all supported parser languages.
 */
export const LANGUAGE_CONFIGS: Record<ParserLanguage, LanguageConfig> = {
  [ParserLanguage.TypeScript]: {
    name: 'TypeScript',
    parserLanguage: ParserLanguage.TypeScript,
    wasmFile: 'tree-sitter-typescript.wasm',
    extensions: ['.ts', '.mts', '.cts'],
  },
  [ParserLanguage.TSX]: {
    name: 'TSX',
    parserLanguage: ParserLanguage.TSX,
    wasmFile: 'tree-sitter-tsx.wasm',
    extensions: ['.tsx'],
  },
  [ParserLanguage.JavaScript]: {
    name: 'JavaScript',
    parserLanguage: ParserLanguage.JavaScript,
    wasmFile: 'tree-sitter-javascript.wasm',
    extensions: ['.js', '.mjs', '.cjs'],
  },
  [ParserLanguage.JSX]: {
    name: 'JSX',
    parserLanguage: ParserLanguage.JSX,
    wasmFile: 'tree-sitter-javascript.wasm',
    extensions: ['.jsx'],
  },
  [ParserLanguage.Python]: {
    name: 'Python',
    parserLanguage: ParserLanguage.Python,
    wasmFile: 'tree-sitter-python.wasm',
    extensions: ['.py', '.pyi', '.pyw'],
  },
  [ParserLanguage.Go]: {
    name: 'Go',
    parserLanguage: ParserLanguage.Go,
    wasmFile: 'tree-sitter-go.wasm',
    extensions: ['.go'],
  },
};

// ============================================================
// Extraction Types
// ============================================================

/**
 * A symbol extracted from the AST before persistence.
 *
 * Similar to SymbolRecord but without `id` and `fileId`,
 * which are assigned when the symbol is stored in the database.
 */
export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  /** Byte offset where the symbol declaration starts. */
  startByte: number;
  /** Byte offset where the symbol declaration ends. */
  endByte: number;
  /** 1-based line where the symbol declaration starts. */
  startLine: number;
  /** 1-based line where the symbol declaration ends. */
  endLine: number;
  /** 0-based UTF-16 column where the symbol declaration starts. */
  startColumn: number;
  /** 0-based UTF-16 column where the symbol declaration ends. */
  endColumn: number;
  /** @deprecated Compatibility alias for startLine; never a byte offset. */
  rangeStart: number;
  /** @deprecated Compatibility alias for endLine; never a byte offset. */
  rangeEnd: number;
  signature: string | null;
  summary: string | null;
  hash: string;
  accessLevel: AccessLevel | null;
}

/**
 * An import extracted from the AST with location information.
 *
 * Extends ImportInfo with byte offsets for incremental updates.
 */
export interface ExtractedImport extends ImportInfo {
  /** Byte offset where the import statement starts. */
  startByte?: number;
  /** Byte offset where the import statement ends. */
  endByte?: number;
  /** @deprecated Compatibility alias for startLine; never a byte offset. */
  rangeStart?: number;
  /** @deprecated Compatibility alias for endLine; never a byte offset. */
  rangeEnd?: number;
}

/**
 * A function/method call extracted from the AST.
 *
 * Used to create CALLS edges between symbols after resolution.
 */
export interface ExtractedCall {
  /** Name of the containing function/method (null if top-level) */
  callerName: string | null;
  /** Name of the called function */
  calleeName: string;
  /** Object expression before the dot (e.g. 'fs' in 'fs.readFile') */
  calleeObject: string | null;
  /** Byte offset where the call expression starts. */
  startByte?: number;
  /** Byte offset where the call expression ends. */
  endByte?: number;
  /** 0-based UTF-16 column where the call expression starts. */
  startColumn?: number;
  /** 0-based UTF-16 column where the call expression ends. */
  endColumn?: number;
  /** 1-based line where the call expression starts. */
  rangeStart: number;
  /** 1-based line where the call expression ends. */
  rangeEnd: number;
  /** Whether this is a constructor call (new X()) */
  isNew: boolean;
}
