export type SearchCandidate = {
  title: string;
  url: string;
  snippet: string;
  provider: string;
};

export type SearchObjective = {
  query: string;
  topic: string;
  timeBudgetMinutes: number;
  preferredFormats?: string[];
};

export interface SearchProvider {
  search(objective: SearchObjective): Promise<SearchCandidate[]>;
}
