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
    '2. Repair project state before reading:',
    '   If resolve_project reports missing config/index, stale index, or an unregistered project, call bootstrap_project, sync_project, or register_project. Then call resolve_project again.',
    '',
    '3. Plan retrieval:',
    '   If resolve_project is ready, call plan_context to choose the route and budget.',
    '',
    '4. Understand a feature or find code:',
    '   Use get_context_pack for bounded evidence, or search_code for ranked matches. Core tools return structured JSON with status, project, freshness, data, nextAction, and display.',
    '',
    '5. Locate symbols:',
    '   Use search_symbols, then find_definition or find_references for exact locations and evidence.',
    '',
    '6. Prepare edits:',
    '   Before editing shared symbols, public contracts, routes, config loaders, parsers, or index lifecycle code, call impact_analysis.',
    '',
    '7. Prepare verification:',
    '   Use get_related_tests to identify narrow validation targets before running repository tests.',
    '',
    '8. Durable knowledge:',
    '   Use remember_project_fact for verified architecture decisions or bug root causes. Use invalidate_memory when stale diagnostics show facts are no longer trustworthy.',
    '',
    'Read/Grep budget strategy:',
    '',
    '- After a ready get_context_pack result, use Read only on data.trustContract.allowedNextReads unless confidence is low or freshness is stale.',
    '- Respect allowedNextReads path, reason, and maxLines. Do not read unrelated files just to re-search the repository.',
    '- Do not run broad Grep/Glob after a ready context pack. Use Grep/Glob only after resolve_project and get_context_pack/search_code return insufficient, low-confidence, or stale evidence.',
    '- If resolve_project reports missing, stale, or unregistered project state, call bootstrap_project, sync_project, or register_project before trusting broad file reads.',
    '',
    'Stale or missing index handling:',
    '',
    '- If diagnostics say the index is missing, call `bootstrap_project` from MCP. Outside MCP, run `code-memory setup --project <path>` for full AI onboarding or `code-memory bootstrap --project <path>` for index-only recovery.',
    '- If diagnostics say the index is stale, call `sync_project` from MCP. Outside MCP, run `code-memory sync --project <path>` or warn the user before relying on old results.',
    '- If diagnostics say the repo is not registered, call `register_project` from MCP or run `code-memory register --project <path>` outside MCP.',
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
