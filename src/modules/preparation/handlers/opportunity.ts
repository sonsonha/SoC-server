import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../../infrastructure/db/client.js';
import { opportunityRequirements, opportunities } from '../../../infrastructure/db/schema/index.js';
import type { LlmProvider } from '../../../infrastructure/providers/llm/types.js';
import type { SearchProvider } from '../../../infrastructure/providers/search/types.js';
import { rankCandidates } from '../../resources/ranker.js';
import { validateOpportunityPrimaryUrl } from '../../resources/opportunityUrlValidator.js';
import { validateCandidateUrl } from '../../resources/urlValidator.js';
import type { PreferenceService } from '../../resources/preferenceService.js';
import type { PreparationRunContext } from './types.js';

const DEFAULT_REQUIREMENTS = [
  'Confirm eligibility criteria',
  'Note application deadline',
  'List required documents',
  'Identify official application portal',
];

export async function runOpportunityPreparation(
  ctx: PreparationRunContext,
  deps: {
    db: Db;
    search: SearchProvider;
    llm: LlmProvider;
    preferences: PreferenceService;
  },
): Promise<void> {
  const { prep, preparationId, excludeResourceIds, excludeUrls, fail, insertResource, finishReady } =
    ctx;
  const { db, search, llm, preferences } = deps;

  const oppRows = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, prep.targetId))
    .limit(1);
  const opportunity = oppRows[0];
  const topic = opportunity?.title ?? 'Opportunity application';

  const prefs = await preferences.getWeights();
  const objective = {
    query: `${topic} official program eligibility deadline application requirements`,
    topic,
    timeBudgetMinutes: prep.timeBudgetMinutes,
    preferredFormats: ['ARTICLE'],
  };

  let candidates;
  try {
    candidates = await search.search(objective);
  } catch (err) {
    await fail(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  candidates = candidates.filter((c) => !excludeUrls.has(c.url));
  if (candidates.length === 0) {
    await ctx.setNeedsInput('No official sources found for this opportunity');
    return;
  }

  const ranked = rankCandidates(candidates, objective, prefs);
  let selected = ranked.find((c) => validateOpportunityPrimaryUrl(c.url, candidates).ok) ?? ranked[0];

  for (const candidate of ranked) {
    const validation = validateOpportunityPrimaryUrl(candidate.url, candidates);
    if (validation.ok) {
      selected = candidate;
      break;
    }
  }

  const urlCheck = validateOpportunityPrimaryUrl(selected.url, candidates);
  if (!urlCheck.ok) {
    const fallback = ranked.find((c) => validateCandidateUrl(c.url, candidates).ok);
    if (!fallback) {
      await fail(urlCheck.reason);
      return;
    }
    selected = fallback;
  }

  const finalCheck = validateCandidateUrl(selected.url, candidates);
  if (!finalCheck.ok) {
    await fail(finalCheck.reason);
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

  const now = new Date();
  const requirementLabels = structured.doneCriteria.length >= 3
    ? structured.doneCriteria
    : DEFAULT_REQUIREMENTS;

  for (let i = 0; i < requirementLabels.length; i++) {
    const reqId = randomUUID();
    await db.insert(opportunityRequirements).values({
      id: reqId,
      opportunityId: prep.targetId,
      label: requirementLabels[i],
      done: false,
      sortOrder: i,
      sourceUrl: i === 0 ? finalCheck.url : null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
  }

  const resourceId = await insertResource({
    title: selected.title,
    url: finalCheck.url,
    format: 'ARTICLE',
    provider: selected.provider,
    snippet: selected.snippet,
    learningItemId: null,
  });

  await finishReady({
    goal: structured.goal || `Complete eligibility check and document list for ${topic}`,
    practicePrompt:
      structured.practicePrompt ||
      `Review the official program page and check off each requirement.`,
    doneCriteria: requirementLabels,
    selectedResourceId: resourceId,
    backupResourceIds: ranked.slice(1, 3).map((c) => c.url),
    provenance: {
      searchQuery: objective.query,
      provider: selected.provider,
      rankReasons: selected.rankReasons.length > 0 ? selected.rankReasons : ['official-source'],
      candidateCount: candidates.length,
      targetType: 'OPPORTUNITY',
      replaced: excludeResourceIds.length > 0,
    },
    freshnessPolicy: 'STATIC',
  });
}
