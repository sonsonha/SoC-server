import type { SearchCandidate, SearchObjective, SearchProvider } from './types.js';

const TCP_CANDIDATES: SearchCandidate[] = [
  {
    title: 'TCP Reliability - retransmission and flow control (Beej\'s Guide)',
    url: 'https://beej.us/guide/bgnet/html/split/man/tcp.html',
    snippet:
      'Covers TCP reliability mechanisms including retransmission, flow control, and congestion basics.',
    provider: 'fake-search',
  },
  {
    title: 'TCP - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Transmission_Control_Protocol',
    snippet: 'Overview of TCP including reliability, sequencing, and congestion control.',
    provider: 'fake-search',
  },
  {
    title: 'High Performance Browser Networking - TCP',
    url: 'https://hpbn.co/tcp/',
    snippet: 'Deep dive on TCP performance and reliability for systems interviews.',
    provider: 'fake-search',
  },
];

const GENERIC_CANDIDATES: SearchCandidate[] = [
  {
    title: 'MDN Web Docs - Learning area',
    url: 'https://developer.mozilla.org/en-US/docs/Learn',
    snippet: 'Structured learning resources for technical topics.',
    provider: 'fake-search',
  },
  {
    title: 'freeCodeCamp Curriculum',
    url: 'https://www.freecodecamp.org/learn',
    snippet: 'Free interactive courses on programming and computer science.',
    provider: 'fake-search',
  },
];

const EXPLORATION_CANDIDATES: SearchCandidate[] = [
  {
    title: 'Singapore tech ecosystem overview - official EDB',
    url: 'https://www.edb.gov.sg/en/our-industries/technology.html',
    snippet: 'Government overview of Singapore technology sector and investment climate.',
    provider: 'fake-search',
  },
  {
    title: 'Singapore startup ecosystem report',
    url: 'https://www.tech.gov.sg/media/technews/singapore-tech-ecosystem',
    snippet: 'Recent summary of Singapore tech hubs, startups, and government initiatives.',
    provider: 'fake-search',
  },
  {
    title: 'ASEAN digital economy - Singapore hub',
    url: 'https://www.imda.gov.sg/how-we-can-help/digital-economy',
    snippet: 'IMDA resources on Singapore as a regional tech and digital hub.',
    provider: 'fake-search',
  },
];

const OPPORTUNITY_CANDIDATES: SearchCandidate[] = [
  {
    title: 'Fulbright Scholar Program - official eligibility',
    url: 'https://fulbright.edu/program/eligibility',
    snippet: 'Official eligibility criteria, deadlines, and required documents.',
    provider: 'fake-search',
  },
  {
    title: 'NSF Graduate Research Fellowship - program guide',
    url: 'https://www.nsf.gov/grfp/eligibility',
    snippet: 'Official NSF GRFP eligibility and application requirements.',
    provider: 'fake-search',
  },
  {
    title: 'Generic fellowship application checklist',
    url: 'https://grants.gov/learn-grantees/application-process',
    snippet: 'Standard application steps and document requirements.',
    provider: 'fake-search',
  },
];

export class FakeSearchProvider implements SearchProvider {
  async search(objective: SearchObjective): Promise<SearchCandidate[]> {
    const q = `${objective.query} ${objective.topic}`.toLowerCase();
    if (q.includes('singapore') || q.includes('explor') || q.includes('ecosystem') || q.includes('trip')) {
      return EXPLORATION_CANDIDATES.map((c) => ({
        ...c,
        title: `${objective.topic}: ${c.title}`,
      }));
    }
    if (
      q.includes('fellowship') ||
      q.includes('scholarship') ||
      q.includes('opportunity') ||
      q.includes('official') ||
      q.includes('eligibility')
    ) {
      return OPPORTUNITY_CANDIDATES.map((c) => ({
        ...c,
        title: `${objective.topic}: ${c.title}`,
      }));
    }
    if (q.includes('tcp') || q.includes('network') || q.includes('reliab')) {
      return TCP_CANDIDATES;
    }
    return GENERIC_CANDIDATES.map((c) => ({
      ...c,
      title: `${objective.topic}: ${c.title}`,
    }));
  }
}

/** Test helper: returns no results. */
export class EmptySearchProvider implements SearchProvider {
  async search(): Promise<SearchCandidate[]> {
    return [];
  }
}
