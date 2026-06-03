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
    '7. MULTI-REPO & CROSS-DIRECTORY SWITCHING:',
'   When switching to a new workspace or directory, you MUST call plan_context (with the correct repo path) FIRST to check index readiness. NEVER skip this and directly call get_repo_map or other heavy retrieval tools — you WILL hit a database-not-found error.',
'',
'8. UNINITIALIZED PROJECT HANDLING:',
'   When plan_context returns a [CODE-MEMORY BOOTSTRAP PROTOCOL] message, the target project has NO index database. You MUST immediately stop your current task reasoning and present the initialization instructions to the user. Do NOT attempt to force-call retrieval tools on an uninitialized project.',
'',
'9. MEMORY-FIRST ON NEW CONVERSATIONS:',
'   At the start of any new conversation or task, you MUST call get_context_pack to actively retrieve historical memories (facts, decisions, preferences) from the persistent store. NEVER skip this and blindly re-explore the codebase with generic search — the memories already contain what you need.',
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
