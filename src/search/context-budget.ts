import type { ContextLevel, ContextPack, TokenBudgets } from '../shared/types.js';
import { estimateTokens } from '../shared/token-counter.js';
import type { SqlJsDatabase } from '../storage/database.js';

export type BudgetTier = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

export interface AdaptiveBudget {
  tier: BudgetTier;
  maxOutputChars: number;
  maxFiles: number;
  maxCharsPerFile: number;
  excludeLowValueFiles: boolean;
  includeRelationships: boolean;
}

export const BUDGET_TIERS: Record<BudgetTier, Omit<AdaptiveBudget, 'tier'>> = {
  tiny:  { maxOutputChars: 13000, maxFiles: 4,  maxCharsPerFile: 3800, excludeLowValueFiles: true,  includeRelationships: false },
  small: { maxOutputChars: 18000, maxFiles: 5,  maxCharsPerFile: 3800, excludeLowValueFiles: true,  includeRelationships: false },
  medium:{ maxOutputChars: 28000, maxFiles: 10, maxCharsPerFile: 6500, excludeLowValueFiles: false, includeRelationships: true  },
  large: { maxOutputChars: 35000, maxFiles: 12, maxCharsPerFile: 7000, excludeLowValueFiles: false, includeRelationships: true  },
  huge:  { maxOutputChars: 38000, maxFiles: 14, maxCharsPerFile: 7000, excludeLowValueFiles: false, includeRelationships: true  },
};

export function getAdaptiveBudget(nodeCount: number): AdaptiveBudget {
  let tier: BudgetTier;
  if (nodeCount < 500) tier = 'tiny';
  else if (nodeCount < 2000) tier = 'small';
  else if (nodeCount < 10000) tier = 'medium';
  else if (nodeCount < 50000) tier = 'large';
  else tier = 'huge';
  return { tier, ...BUDGET_TIERS[tier] };
}

export function isLowValueFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /\.(test|spec)\.[^./]+$/.test(lower) ||     // *.test.ts, *.spec.js
    /(^|\/)__tests__\//.test(lower) ||          // __tests__/foo.ts
    /(^|\/)__mocks__\//.test(lower) ||          // __mocks__/foo.ts
    /(^|\/)(mock|fixture|stub)([-./]|$)/.test(lower) // mock.ts, fixture.json, stub.js, mock-helper.ts
  );
}

export function filterLowValueFiles<T extends { path: string }>(files: T[]): T[] {
  return files.filter((f) => !isLowValueFile(f.path));
}

export function countIndexedNodes(db: SqlJsDatabase): number {
  try {
    const row = db.get<{ count: number }>(
      'SELECT (SELECT COUNT(*) FROM files) + (SELECT COUNT(*) FROM symbols) AS count',
    );
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export function applyOutputCharBudget(text: string, maxOutputChars: number): string {
  if (text.length <= maxOutputChars) return text;
  const dropped = text.length - maxOutputChars;
  return text.slice(0, maxOutputChars) + "\n\n... (truncated, " + dropped + " more chars)...";
}

export function resolveContextLevel(
  budget: number,
  budgets: TokenBudgets,
  requestedMaxLevel?: ContextLevel,
): ContextLevel {
  const budgetLevel = determineContextLevel(budget, budgets);
  if (!requestedMaxLevel) return budgetLevel;

  return compareContextLevels(requestedMaxLevel, budgetLevel) < 0
    ? requestedMaxLevel
    : budgetLevel;
}

export function estimatePackTokens(pack: ContextPack): number {
  return estimateTokens(JSON.stringify(pack.projectCard || '')) +
    estimateTokens(pack.relevantMemories.map((memory) => memory.content).join('\n')) +
    estimateTokens(pack.files.map((file) => file.path + ' ' + file.reason).join('\n')) +
    estimateTokens(pack.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.filePath,
      symbol.signature || '',
      symbol.summary || '',
    ].join(' ')).join('\n')) +
    pack.codeSnippets.reduce((sum, snippet) => sum + snippet.tokenCount, 0) +
    estimateTokens(pack.callChains.join('\n')) +
    estimateTokens(pack.missing.join('\n'));
}

function determineContextLevel(budget: number, budgets: TokenBudgets): ContextLevel {
  if (budget <= budgets.L0) return 'L0';
  if (budget <= budgets.L1) return 'L1';
  if (budget <= budgets.L2) return 'L2';
  if (budget <= budgets.L3) return 'L3';
  if (budget <= budgets.L4) return 'L4';
  return 'L5';
}

function compareContextLevels(a: ContextLevel, b: ContextLevel): number {
  return contextLevelRank(a) - contextLevelRank(b);
}

function contextLevelRank(level: ContextLevel): number {
  switch (level) {
    case 'L0': return 0;
    case 'L1': return 1;
    case 'L2': return 2;
    case 'L3': return 3;
    case 'L4': return 4;
    case 'L5': return 5;
  }
}
