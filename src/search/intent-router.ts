import type {
  EdgeType,
  GraphEdgeProfile,
  IntentClassification,
  SearchIntent,
} from '../shared/types.js';

interface IntentRule {
  intent: Exclude<SearchIntent, 'general'>;
  hints: string[];
}

const INTENT_RULES: IntentRule[] = [
  {
    intent: 'debug',
    hints: ['debug', 'bug', 'error', 'fix', 'failing', 'failure', 'stack trace', 'why'],
  },
  {
    intent: 'refactor',
    hints: ['refactor', 'rename', 'move', 'extract', 'split', 'without breaking'],
  },
  {
    intent: 'add_test',
    hints: ['add test', 'regression', 'coverage', 'spec', 'unit test', 'integration test'],
  },
  {
    intent: 'route',
    hints: ['route', 'handler', 'endpoint', '/api/', 'post ', 'get ', 'put ', 'delete '],
  },
  {
    intent: 'explain',
    hints: ['explain', 'how', 'what does', 'walkthrough', 'architecture'],
  },
  {
    intent: 'security',
    hints: ['security', 'permission', 'token', 'secret', 'auth bypass', 'jwt'],
  },
];

const GRAPH_PROFILES: Record<Exclude<SearchIntent, 'general'>, GraphEdgeProfile> = {
  debug: {
    name: 'debug',
    direction: 'both',
    edgeTypes: ['CALLS', 'REFERENCES', 'IMPORTS', 'CONFIGURES', 'ROUTE_REFERENCES'],
    effectiveEdgeTypes: ['CALLS', 'REFERENCES', 'IMPORTS', 'CONFIGURES', 'ROUTE_REFERENCES'],
  },
  refactor: {
    name: 'refactor',
    direction: 'incoming',
    edgeTypes: ['REFERENCES', 'CALLS', 'IMPORTS', 'TESTS'],
    effectiveEdgeTypes: ['REFERENCES', 'CALLS', 'IMPORTS', 'TESTS'],
  },
  add_test: {
    name: 'add_test',
    direction: 'both',
    edgeTypes: ['CALLS', 'IMPORTS', 'TESTS'],
    effectiveEdgeTypes: ['CALLS', 'IMPORTS', 'TESTS'],
  },
  explain: {
    name: 'explain',
    direction: 'outgoing',
    edgeTypes: ['CONTAINS', 'IMPORTS', 'EXPORTS_TO'],
    effectiveEdgeTypes: ['CONTAINS', 'IMPORTS', 'EXPORTS_TO'],
  },
  route: {
    name: 'route',
    direction: 'both',
    edgeTypes: ['ROUTE_ENDPOINT', 'ROUTE_REFERENCES', 'CALLS'],
    // Existing route references are persisted as REFERENCES edges. Keep that
    // compatibility while the public profile names the route-specific edge.
    effectiveEdgeTypes: ['ROUTE_ENDPOINT', 'ROUTE_REFERENCES', 'REFERENCES', 'CALLS'],
  },
  security: {
    name: 'security',
    direction: 'both',
    edgeTypes: ['CALLS', 'REFERENCES', 'IMPORTS', 'CONFIGURES'],
    effectiveEdgeTypes: ['CALLS', 'REFERENCES', 'IMPORTS', 'CONFIGURES'],
  },
};

export function classifySearchIntent(
  query: string,
  explicitIntent?: SearchIntent,
): IntentClassification {
  if (explicitIntent) {
    return {
      intent: explicitIntent,
      matchedHints: explicitIntent === 'general' ? [] : [explicitIntent],
      source: 'explicit',
    };
  }

  const normalized = query.toLowerCase();
  for (const rule of INTENT_RULES) {
    const matchedHints = rule.hints.filter((hint) => normalized.includes(hint));
    if (
      rule.intent === 'add_test'
      && !matchedHints.includes('add test')
      && /\badd\b[\s\S]*\btests?\b/i.test(query)
    ) {
      matchedHints.unshift('add test');
    }
    if (matchedHints.length > 0) {
      return {
        intent: rule.intent,
        matchedHints,
        source: 'inferred',
      };
    }
  }

  return {
    intent: 'general',
    matchedHints: [],
    source: 'default',
  };
}

export function getIntentGraphProfile(intent: SearchIntent): GraphEdgeProfile | null {
  if (intent === 'general') return null;
  const profile = GRAPH_PROFILES[intent];
  return {
    ...profile,
    edgeTypes: [...profile.edgeTypes] as EdgeType[],
    effectiveEdgeTypes: profile.effectiveEdgeTypes
      ? [...profile.effectiveEdgeTypes] as EdgeType[]
      : undefined,
  };
}

export function getEffectiveGraphEdgeTypes(profile: GraphEdgeProfile): EdgeType[] {
  return [...(profile.effectiveEdgeTypes || profile.edgeTypes)];
}
