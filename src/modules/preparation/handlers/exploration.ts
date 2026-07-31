import type { Db } from '../../../infrastructure/db/client.js';
import type { LlmProvider } from '../../../infrastructure/providers/llm/types.js';
import type { SearchProvider } from '../../../infrastructure/providers/search/types.js';
import { rankCandidates } from '../../resources/ranker.js';
import { validateCandidateUrl } from '../../resources/urlValidator.js';
import type { PreferenceService } from '../../resources/preferenceService.js';
import type { PreparationRunContext } from './types.js';

export async function runExplorationPreparation(
  ctx: PreparationRunContext,
  deps: {
    db: Db;
    search: SearchProvider;
    llm: LlmProvider;
    preferences: PreferenceService;
  },
): Promise<void> {
  const { prep, excludeUrls, fail, insertResource, finishReady } = ctx;
  const { search, llm, preferences } = deps;

  const topic = prep.goal || prep.targetId.replace(/^exploration-/, '').replace(/-/g, ' ');
  const question = topic.startsWith('Answer:') ? topic : `Answer: ${topic}`;

  const prefs = await preferences.getWeights();
  const objective = {
    query: `${topic} overview guide ecosystem recent`,
    topic,
    timeBudgetMinutes: prep.timeBudgetMinutes,
    preferredFormats: prefs.penalizeVideo ? ['ARTICLE'] : ['ARTICLE', 'VIDEO'],
  };

  let candidates;
  try {
    candidates = await search.search(objective);
  } catch (err) {
    await fail(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  candidates = candidates.filter((c) => !excludeUrls.has(c.url));
  if (candidates.length < 2) {
    await ctx.setNeedsInput('Need at least 2 overview sources for exploration');
    return;
  }

  const ranked = rankCandidates(candidates, objective, prefs);
  let selected = ranked[0];
  for (const candidate of ranked) {
    const validation = validateCandidateUrl(candidate.url, candidates);
    if (validation.ok) {
      selected = candidate;
      break;
    }
  }

  const urlCheck = validateCandidateUrl(selected.url, candidates);
  if (!urlCheck.ok) {
    await fail(urlCheck.reason);
    return;
  }

  let structured;
  try {
    structured = await llm.structurePreparation({
      topic,
      timeBudgetMinutes: prep.timeBudgetMinutes,
      candidate: selected,
    });
  } catch {
    await fail('LLM structuring failed');
    return;
  }

  const questions =
    structured.doneCriteria.length >= 3
      ? structured.doneCriteria
      : [
          'What are the major tech hubs and sectors?',
          'Which companies or agencies matter for your goals?',
          'What recent trends should you know before visiting?',
        ];

  const resourceId = await insertResource({
    title: selected.title,
    url: urlCheck.url,
    format: selected.url.includes('youtube') ? 'VIDEO' : 'ARTICLE',
    provider: selected.provider,
    snippet: selected.snippet,
    learningItemId: null,
  });

  await finishReady({
    goal: question,
    practicePrompt:
      structured.practicePrompt ||
      `Skim the top sources; note 5 facts relevant to your trip or decision.`,
    doneCriteria: questions,
    selectedResourceId: resourceId,
    backupResourceIds: ranked.slice(1, 3).map((c) => c.url),
    provenance: {
      searchQuery: objective.query,
      provider: selected.provider,
      rankReasons: selected.rankReasons.length > 0 ? selected.rankReasons : ['recency'],
      candidateCount: candidates.length,
      targetType: 'EXPLORATION',
      backupSources: ranked.slice(1, 3).map((c) => ({ title: c.title, url: c.url })),
    },
    freshnessPolicy: 'DAILY',
  });
}
