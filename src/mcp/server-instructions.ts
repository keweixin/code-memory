export const CODE_MEMORY_MARKER_START = '<!-- CODE_MEMORY_START -->';
export const CODE_MEMORY_MARKER_END = '<!-- CODE_MEMORY_END -->';

export function getServerInstructions(): string {
  return [
    'Code Memory is a local, context-budgeted architectural graph and long-term memory ledger for code navigation.',
    '',
    'Recommended Code Memory workflow:',
    '',
    '1. New task or repo switch:',
    '   When using Code Memory for code navigation, start with plan_context to check readiness and choose the retrieval route.',
    '',
    '2. Understand a feature or find code:',
    '   Use get_context_pack for bounded evidence, or search_code for ranked matches.',
    '',
    '3. Locate symbols:',
    '   Use search_symbols, then find_definition or find_references for exact locations and evidence.',
    '',
    '4. Prepare edits:',
    '   Before editing shared symbols, public contracts, routes, config loaders, parsers, or index lifecycle code, call impact_analysis.',
    '',
    '5. Prepare verification:',
    '   Use get_related_tests to identify narrow validation targets before running repository tests.',
    '',
    '6. Durable knowledge:',
    '   Use remember_project_fact for verified architecture decisions or bug root causes. Use invalidate_memory when stale diagnostics show facts are no longer trustworthy.',
    '',
    'Stale or missing index handling:',
    '',
    '- If diagnostics say the index is missing, run or suggest `code-memory setup --project <path>` for full AI onboarding, or `code-memory bootstrap --project <path>` for index-only recovery.',
    '- If diagnostics say the index is stale, refresh with `code-memory sync --project <path>` or warn the user before relying on old results.',
    '- If a stale memory alert appears, invalidate affected memories before saving refreshed facts.',
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
