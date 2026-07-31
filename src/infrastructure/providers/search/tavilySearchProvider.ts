import type { SearchCandidate, SearchObjective, SearchProvider } from './types.js';

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
};

type TavilyResponse = {
  results?: TavilyResult[];
};

export class TavilySearchProvider implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(objective: SearchObjective): Promise<SearchCandidate[]> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: objective.query,
        max_results: 10,
        include_answer: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as TavilyResponse;
    return (data.results ?? [])
      .filter((r): r is TavilyResult & { url: string } => Boolean(r.url))
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        snippet: r.content ?? '',
        provider: 'tavily',
      }));
  }
}
