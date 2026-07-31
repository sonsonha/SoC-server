import type { AppConfig } from '../../../config.js';
import { FakeSearchProvider } from './fakeSearchProvider.js';
import { TavilySearchProvider } from './tavilySearchProvider.js';
import type { SearchProvider } from './types.js';

export function createSearchProvider(config: AppConfig): SearchProvider {
  if (!config.USE_FAKE_PROVIDERS && config.SEARCH_API_KEY) {
    return new TavilySearchProvider(config.SEARCH_API_KEY);
  }
  return new FakeSearchProvider();
}

export * from './types.js';
export { FakeSearchProvider, EmptySearchProvider } from './fakeSearchProvider.js';
