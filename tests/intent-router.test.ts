import { describe, expect, it } from 'vitest';
import {
  classifySearchIntent,
  getIntentGraphProfile,
} from '../src/search/intent-router.js';

describe('intent router', () => {
  it('classifies search intent with deterministic keyword hints', () => {
    const cases = [
      {
        query: 'debug login timeout failing stack trace',
        intent: 'debug',
        hints: ['debug', 'failing', 'stack trace'],
      },
      {
        query: 'refactor AuthService rename without breaking callers',
        intent: 'refactor',
        hints: ['refactor', 'rename'],
      },
      {
        query: 'add regression test for password validation',
        intent: 'add_test',
        hints: ['add test', 'regression'],
      },
      {
        query: 'explain how token issuance works',
        intent: 'explain',
        hints: ['explain', 'how'],
      },
      {
        query: 'route handler for POST /api/user/save',
        intent: 'route',
        hints: ['route', '/api/'],
      },
      {
        query: 'security audit hardcoded secret auth bypass',
        intent: 'security',
        hints: ['security', 'secret', 'auth bypass'],
      },
      {
        query: 'AuthService login',
        intent: 'general',
        hints: [],
      },
    ] as const;

    for (const entry of cases) {
      const result = classifySearchIntent(entry.query);
      expect(result.intent).toBe(entry.intent);
      expect(result.matchedHints).toEqual(expect.arrayContaining([...entry.hints]));
    }
  });

  it('prefers explicit intent over inferred hints for diagnostics', () => {
    const result = classifySearchIntent('debug login failure', 'explain');

    expect(result.intent).toBe('explain');
    expect(result.source).toBe('explicit');
    expect(result.matchedHints).toEqual(['explain']);
  });

  it('exposes graph edge profiles for routed intents', () => {
    expect(getIntentGraphProfile('debug')).toMatchObject({
      name: 'debug',
      direction: 'both',
      edgeTypes: ['CALLS', 'REFERENCES', 'IMPORTS', 'CONFIGURES', 'ROUTE_REFERENCES'],
    });
    expect(getIntentGraphProfile('refactor')).toMatchObject({
      name: 'refactor',
      direction: 'incoming',
      edgeTypes: ['REFERENCES', 'CALLS', 'IMPORTS', 'TESTS'],
    });
    expect(getIntentGraphProfile('route')).toMatchObject({
      name: 'route',
      direction: 'both',
      edgeTypes: ['ROUTE_ENDPOINT', 'ROUTE_REFERENCES', 'CALLS'],
    });
    expect(getIntentGraphProfile('general')).toBeNull();
  });
});
