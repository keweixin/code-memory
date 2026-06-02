export const CODE_MEMORY_MARKER_START = '<!-- CODE_MEMORY_START -->';
export const CODE_MEMORY_MARKER_END = '<!-- CODE_MEMORY_END -->';

export function getServerInstructions(): string {
  return [
    'Code Memory is an autonomous, context-budgeted architectural graph and long-term memory ledger.',
    '',
    'STRICT OPERATIONAL DIRECTIVES (MUST FOLLOW):',
    '',
    '1. BEFORE ANY NEW TASK — MEMORY FIRST:',
    '   You MUST call plan_context + get_project_card FIRST to retrieve all existing long-term memories (facts, decisions, preferences). NEVER skip this step and jump straight to reading code.',
    '',
    '2. CONTEXT RETRIEVAL:',
    '   Always use get_context_pack with a stable sessionId and avoidRepeated: true. Use the Context Ledger to avoid re-reading previously seen chunks.',
    '',
    '3. AUTO-REMEMBER IMPORTANT FINDINGS:',
    '   When you discover architectural patterns, key design decisions, module responsibilities, or bug root causes — you MUST call remember_project_fact BEFORE finishing the task. Always include scope (file paths) so auto-invalidation rules are generated.',
    '',
    '4. STALE MEMORY ALERTS:',
    '   If you see [CODE-MEMORY CRITICAL ALERT] in search results or context packs, it means project memories have gone stale. You MUST call invalidate_memory to clear obsolete memories, then remember_project_fact to refresh them.',
    '',
    '5. MEMORY QUALITY RULES:',
    '   - Every memory MUST include scope (related file paths).',
    '   - Decision-type memories should include evidence files.',
    '   - Confidence: certain facts = 1.0, inferences = 0.8, guesses = 0.5.',
    '   - Do NOT create duplicate memories — search first.',
    '',
    '6. STALE INDEX HANDLING:',
    '   Treat stale or missing index diagnostics as a reason to run code-memory sync or code-memory index --full.',
    '',
    '7. MULTI-REPO:',
    '   When working across registered repositories, pass repo to repo-aware tools.',
  ].join('\n');
}

export function getManagedInstructionBlock(command = 'code-memory', args: string[] = ['serve', '--watch']): string {
  return [
    CODE_MEMORY_MARKER_START,
    getServerInstructions(),
    '',
    'MCP server:',
    '```json',
    JSON.stringify({
      command,
      args,
    }, null, 2),
    '```',
    CODE_MEMORY_MARKER_END,
  ].join('\n');
}
