import { describe, expect, it } from 'vitest';
import { validateCandidateUrl } from './urlValidator.js';

const SEARCH_RESULTS = [
  {
    title: 'Real result',
    url: 'https://beej.us/guide/bgnet/html/split/man/tcp.html',
    snippet: 'TCP guide',
    provider: 'fake',
  },
];

describe('validateCandidateUrl', () => {
  it('accepts URLs present in search results', () => {
    const result = validateCandidateUrl(
      'https://beej.us/guide/bgnet/html/split/man/tcp.html',
      SEARCH_RESULTS,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects hallucinated URLs not in search results', () => {
    const result = validateCandidateUrl('https://evil.example/fake-tcp', SEARCH_RESULTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('search results');
    }
  });
});
