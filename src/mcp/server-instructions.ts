export const CODE_MEMORY_MARKER_START = '<!-- CODE_MEMORY_START -->';
export const CODE_MEMORY_MARKER_END = '<!-- CODE_MEMORY_END -->';

export function getServerInstructions(): string {
  return [
    'Code Memory is a local Context Ledger and evidence-backed code graph for coding agents.',
    '',
    'Recommended workflow:',
    '1. Call plan_context first to classify the task and inspect index/vector/ledger status.',
    '2. Call get_context_pack with a stable sessionId. Use avoidRepeated: true after the first context pack.',
    '3. Prefer L1-L3 context first; request L4 snippets only when code is needed.',
    '4. Use search_code for focused retrieval and inspect scoreBreakdown, diagnostics, and evidence.',
    '5. Call mark_context_used after manually reading additional files or using returned context.',
    '6. Treat stale or missing index diagnostics as a reason to run code-memory sync or code-memory index --full.',
    '7. When working across registered repositories, pass repo to repo-aware tools such as search_code, find_definition, get_call_graph, plan_context, get_context_pack, and Context Ledger tools.',
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
