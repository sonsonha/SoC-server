import type { PreparationRunContext } from './types.js';
import type { SearchProvider } from '../../../infrastructure/providers/search/types.js';
import type { LlmProvider } from '../../../infrastructure/providers/llm/types.js';
import type { Db } from '../../../infrastructure/db/client.js';
import type { PreferenceService } from '../../resources/preferenceService.js';

/**
 * NEWS prep: curated 3-item queue (no feed). Categories as labels only.
 */
export async function runNewsPreparation(
  ctx: PreparationRunContext,
  deps: {
    db: Db;
    search: SearchProvider;
    llm: LlmProvider;
    preferences: PreferenceService;
  },
): Promise<void> {
  const { prep, insertResource, finishReady } = ctx;
  const topic = prep.goal?.trim() || 'top technology and world news brief';

  let results: Array<{ title: string; url: string; snippet?: string }> = [];
  try {
    const found = await deps.search.search({
      query: `${topic} news`,
      topic,
      timeBudgetMinutes: prep.timeBudgetMinutes,
      preferredFormats: ['ARTICLE'],
    });
    results = found.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    }));
  } catch {
    results = [];
  }

  type Curated = { title: string; url: string; snippet?: string; category: string };
  const curated: Curated[] = results.slice(0, 3).map((r, i) => {
    const category = i === 0 ? 'World' : i === 1 ? 'Tech' : 'Business';
    return { ...r, category };
  });

  if (curated.length === 0) {
    curated.push(
      {
        title: 'Morning brief — markets & policy',
        url: 'https://example.com/news/markets',
        snippet: 'Curated placeholder when search is unavailable.',
        category: 'Business',
      },
      {
        title: 'Tech radar — shipping & infra',
        url: 'https://example.com/news/tech',
        snippet: 'Three-item queue placeholder.',
        category: 'Tech',
      },
      {
        title: 'World desk — overnight headlines',
        url: 'https://example.com/news/world',
        snippet: 'Scan and pick one deep-dive.',
        category: 'World',
      },
    );
  }

  const primary = curated[0];
  const resourceId = await insertResource({
    title: primary.title,
    url: primary.url,
    format: 'ARTICLE',
    provider: 'news_queue',
    snippet: primary.snippet ?? '',
    learningItemId: null,
    metadata: null,
  });

  const queue = curated.map((c) => ({
    title: c.title,
    url: c.url,
    category: c.category,
    snippet: c.snippet ?? null,
  }));

  await finishReady({
    selectedResourceId: resourceId,
    backupResourceIds: [],
    goal: `Scan 3 curated items · deep-dive one (${topic})`,
    practicePrompt: queue.map((q, i) => `${i + 1}. [${q.category}] ${q.title}`).join('\n'),
    doneCriteria: [
      'Opened all 3 queue items',
      'Chose one article for a 5-minute note',
      'Logged one actionable takeaway',
    ],
    provenance: {
      kind: 'NEWS_QUEUE',
      queue,
      selectedUrl: primary.url,
    },
    freshnessPolicy: 'DAILY',
  });
}
