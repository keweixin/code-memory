export const CODE_MEMORY_MARKER_START = '<!-- CODE_MEMORY_START -->';
export const CODE_MEMORY_MARKER_END = '<!-- CODE_MEMORY_END -->';

export function getServerInstructions(): string {
  return [
    'Code Memory is a local, context-budgeted architectural graph and long-term memory ledger for code navigation.',
    '',
    'Recommended Code Memory workflow:',
    '',
    '1. New task or repo switch:',
    '   Before Read/Grep/Glob, call resolve_project to verify project identity and index readiness.',
    '',
    '2. Plan retrieval:',
    '   If resolve_project is ready, call plan_context to choose the route and budget.',
    '',
    '3. Understand a feature or find code:',
    '   Use get_context_pack for bounded evidence, or search_code for ranked matches.',
    '',
    '4. Locate symbols:',
    '   Use search_symbols, then find_definition or find_references for exact locations and evidence.',
    '',
    '5. Prepare edits:',
    '   Before editing shared symbols, public contracts, routes, config loaders, parsers, or index lifecycle code, call impact_analysis.',
    '',
    '6. Prepare verification:',
    '   Use get_related_tests to identify narrow validation targets before running repository tests.',
    '',
    '7. Durable knowledge:',
    '   Use remember_project_fact for verified architecture decisions or bug root causes. Use invalidate_memory when stale diagnostics show facts are no longer trustworthy.',
    '',
    'Read/Grep budget strategy:',
    '',
    '- Use Read only for files returned by Code Memory when extra source detail is needed.',
    '- Use Grep/Glob only after resolve_project and get_context_pack/search_code return insufficient or stale evidence.',
    '- If resolve_project reports missing or stale index, run the returned bootstrap/sync command before trusting broad file reads.',
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
