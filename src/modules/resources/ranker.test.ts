import { describe, expect, it } from 'vitest';
import { rankCandidates } from './ranker.js';
import type { SearchCandidate } from '../../infrastructure/providers/search/types.js';

const FIXTURE: SearchCandidate[] = [
  {
    title: 'Random blog post',
    url: 'https://example.com/random',
    snippet: 'Unrelated content about cooking.',
    provider: 'fake',
  },
  {
    title: 'TCP Reliability - Beej Guide',
    url: 'https://beej.us/guide/bgnet/html/split/man/tcp.html',
    snippet: 'TCP reliability retransmission flow control congestion.',
    provider: 'fake',
  },
  {
    title: 'TCP - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Transmission_Control_Protocol',
    snippet: 'Transmission Control Protocol reliability.',
    provider: 'fake',
  },
];

describe('rankCandidates', () => {
  it('orders TCP-relevant candidates above unrelated results', () => {
    const ranked = rankCandidates(FIXTURE, {
      query: 'TCP reliability tutorial',
      topic: 'TCP reliability',
      timeBudgetMinutes: 45,
    });
    expect(ranked[0].url).toContain('beej.us');
    expect(ranked[0].score).toBeGreaterThan(ranked[ranked.length - 1].score);
  });

  it('TOO_LONG preferences rank shorter snippets higher', () => {
    const longSnippet = {
      title: 'TCP comprehensive deep dive full course',
      url: 'https://example.com/long-tcp',
      snippet:
        'A comprehensive deep dive full course covering every aspect of TCP reliability in extreme detail with many hours of content.',
      provider: 'fake',
    };
    const shortSnippet = {
      title: 'TCP quick guide',
      url: 'https://beej.us/guide/bgnet/html/split/man/tcp.html',
      snippet: 'TCP reliability retransmission flow control.',
      provider: 'fake',
    };
    const withoutPrefs = rankCandidates([longSnippet, shortSnippet], {
      query: 'TCP reliability',
      topic: 'TCP reliability',
      timeBudgetMinutes: 45,
    });
    const withPrefs = rankCandidates(
      [longSnippet, shortSnippet],
      {
        query: 'TCP reliability',
        topic: 'TCP reliability',
        timeBudgetMinutes: 20,
      },
      {
        maxDurationMinutes: 20,
        penalizeLongForm: true,
      },
    );
    expect(withPrefs[0].url).toContain('beej.us');
    expect(withPrefs[0].score).toBeGreaterThan(withPrefs[1].score);
    expect(withoutPrefs[0].score).toBeGreaterThanOrEqual(withoutPrefs[1].score - 5);
  });
});
