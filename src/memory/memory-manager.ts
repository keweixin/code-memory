/**
 * Code Memory Graph — Memory Manager
 *
 * Unified interface for reading and writing project memories.
 * Coordinates between session memory, repo memory, and decision
 * memory modules.
 *
 * Every memory carries:
 * - evidence: files/symbols that support the memory
 * - scope: glob patterns defining applicable files
 * - invalidation rules: conditions that make the memory stale
 */

import type { Database as SqlJsDatabase } from 'sql.js';
import type { MemoryRecord, MemoryType, InvalidationRule } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { generateId } from '../shared/utils.js';
import {
  createMemory,
  getMemoryById,
  getMemoriesByType,
  getMemoriesByScope,
  updateMemory,
  deleteMemory,
} from '../storage/memory-repository.js';
import { getDatabaseSync } from '../storage/database.js';

const log = createLogger('memory-manager');

export class MemoryManager {
  private db: SqlJsDatabase;

  constructor() {
    this.db = getDatabaseSync();
  }

  /**
   * Remember a project fact with evidence, scope, and invalidation rules.
   */
  remember(
    content: string,
    options: {
      type?: MemoryType;
      evidence?: string[];
      scope?: string[];
      invalidateOn?: InvalidationRule[];
      confidence?: number;
    } = {},
  ): string {
    const memory: MemoryRecord = {
      id: generateId(content + (options.type || 'repo') + Date.now().toString()),
      type: options.type || 'repo',
      content,
      scope: options.scope || [],
      evidence: options.evidence || [],
      confidence: options.confidence ?? 1.0,
      createdCommit: null,
      lastValidatedCommit: null,
      invalidationRules: options.invalidateOn || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    createMemory(memory);
    log.info(`Memory created: ${memory.id} (type: ${memory.type})`);
    return memory.id;
  }

  /**
   * Record an architecture decision in ADR format.
   */
  rememberDecision(
    title: string,
    context: string,
    decision: string,
    consequences: string,
    options: { evidence?: string[]; scope?: string[]; confidence?: number } = {},
  ): string {
    const content = JSON.stringify({
      title,
      context,
      decision,
      consequences,
      recorded_at: new Date().toISOString(),
    });

    return this.remember(content, {
      type: 'decision',
      evidence: options.evidence || [],
      scope: options.scope || [],
      confidence: options.confidence ?? 0.95,
      invalidateOn: [
        {
          type: 'file_change',
          target: options.evidence?.[0] || '*',
          description: `ADR invalidated if evidence file changes: ${(options.evidence || ['*']).join(', ')}`,
        },
      ],
    });
  }

  /**
   * Get memories of a specific type.
   */
  getByType(type: MemoryType): MemoryRecord[] {
    return getMemoriesByType(type);
  }

  /**
   * Get memories applicable to a given file path.
   * Matches against scope glob patterns.
   */
  getForFile(filePath: string): MemoryRecord[] {
    return getMemoriesByScope(filePath);
  }

  /**
   * Get a single memory by ID.
   */
  getById(id: string): MemoryRecord | null {
    return getMemoryById(id) || null;
  }

  /**
   * Invalidate a memory by marking it as expired.
   */
  invalidate(memoryId: string): void {
    updateMemory(memoryId, {
      confidence: 0,
      updatedAt: new Date().toISOString(),
    });
    log.info(`Memory invalidated: ${memoryId}`);
  }

  /**
   * Check which memories should be invalidated based on file changes.
   * Returns list of memory IDs that are now stale.
   */
  checkInvalidation(changedFiles: string[]): string[] {
    const allMemories = [
      ...getMemoriesByType('repo'),
      ...getMemoriesByType('decision'),
    ];

    const staleIds: string[] = [];

    for (const memory of allMemories) {
      for (const rule of memory.invalidationRules) {
        if (rule.type === 'file_change') {
          for (const file of changedFiles) {
            if (file === rule.target || file.includes(rule.target)) {
              // Check if update is needed
              if (memory.confidence > 0.5) {
                // Not a full invalidation, but reduce confidence
                updateMemory(memory.id, {
                  confidence: Math.max(0, memory.confidence - 0.3),
                  updatedAt: new Date().toISOString(),
                });
                log.info(`Memory confidence reduced: ${memory.id} (file changed: ${file})`);
              } else {
                staleIds.push(memory.id);
              }
            }
          }
        }
      }
    }

    return staleIds;
  }

  /**
   * Get all memories as human-readable text.
   */
  formatForContext(memories: MemoryRecord[]): string[] {
    return memories.map((m) => {
      const confidence = m.confidence >= 0.8 ? 'High' :
        m.confidence >= 0.5 ? 'Medium' : 'Low';
      return `${confidence} confidence (${m.type}): ${m.content}`;
    });
  }

  /**
   * Check if a memory is still valid given the current codebase state.
   */
  validate(memoryId: string, currentCommit: string): boolean {
    const memory = getMemoryById(memoryId);
    if (!memory) return false;
    if (memory.confidence < 0.3) return false;

    // Update validation timestamp
    updateMemory(memoryId, {
      lastValidatedCommit: currentCommit,
      updatedAt: new Date().toISOString(),
    });

    return true;
  }
}
