import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import {
  learningItems,
  preparationRevisions,
  preparations,
  resourceCandidates,
  resources,
  tasks,
} from '../infrastructure/db/schema/index.js';
import { getActiveProfile } from './syncService.js';
import type { LlmProvider } from '../infrastructure/providers/llm/types.js';
import type { SearchProvider } from '../infrastructure/providers/search/types.js';
import { rankCandidates } from '../modules/resources/ranker.js';
import { PreferenceService } from '../modules/resources/preferenceService.js';
import { validateCandidateUrl } from '../modules/resources/urlValidator.js';
import { runExplorationPreparation } from '../modules/preparation/handlers/exploration.js';
import { runOpportunityPreparation } from '../modules/preparation/handlers/opportunity.js';
import { runNewsPreparation } from '../modules/preparation/handlers/news.js';
import {
  refreshSocialPreparation,
  runSocialPreparation,
} from '../modules/preparation/handlers/social.js';
import type { PreparationRunContext } from '../modules/preparation/handlers/types.js';
import type { PlacesProvider } from '../infrastructure/providers/maps/types.js';
import type { DistanceMatrixProvider } from '../infrastructure/providers/calendar/types.js';
import type { ResourceMetadata } from '../infrastructure/db/schema/resources.js';
import { FakePlacesProvider } from '../infrastructure/providers/maps/fakePlacesProvider.js';
import { FakeDistanceMatrixProvider } from '../infrastructure/providers/maps/distanceMatrix.js';
import type { NotificationService } from '../infrastructure/notifications/notificationService.js';

export class PreparationService {
  private readonly preferences: PreferenceService;
  private readonly places: PlacesProvider;
  private readonly distance: DistanceMatrixProvider;
  private notifications: NotificationService | null = null;

  constructor(
    private readonly db: Db,
    private readonly search: SearchProvider,
    private readonly llm: LlmProvider,
    places?: PlacesProvider,
    distance?: DistanceMatrixProvider,
  ) {
    this.preferences = new PreferenceService(db);
    this.places = places ?? new FakePlacesProvider();
    this.distance = distance ?? new FakeDistanceMatrixProvider();
  }

  setNotificationService(service: NotificationService): void {
    this.notifications = service;
  }

  async getById(id: string) {
    const rows = await this.db.select().from(preparations).where(eq(preparations.id, id)).limit(1);
    const prep = rows[0];
    if (!prep) return null;

    let resource = null;
    if (prep.selectedResourceId) {
      const resRows = await this.db
        .select()
        .from(resources)
        .where(eq(resources.id, prep.selectedResourceId))
        .limit(1);
      resource = resRows[0] ?? null;
    }

    const provenance =
      prep.provenance && Object.keys(prep.provenance).length > 0
        ? prep.provenance
        : { searchQuery: '', provider: '', rankReasons: [], candidateCount: 0 };

    return {
      preparation: { ...prep, provenance },
      resource,
    };
  }

  async listForDate(date: string) {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    const rows = await this.db.select().from(preparations);
    return rows.filter((p) => {
      const t = p.scheduledStartAt.getTime();
      return t >= dayStart.getTime() && t <= dayEnd.getTime() && !p.deletedAt;
    });
  }

  async start(id: string): Promise<{ startedAt: string }> {
    const now = new Date();
    await this.db
      .update(preparations)
      .set({
        provenance: { startedAt: now.toISOString() },
        revision: 2,
        updatedAt: now,
      })
      .where(eq(preparations.id, id));
    return { startedAt: now.toISOString() };
  }

  async run(preparationId: string): Promise<void> {
    await this.executePipeline(preparationId, []);
  }

  async replace(preparationId: string, excludeResourceIds: string[]): Promise<void> {
    await this.executePipeline(preparationId, excludeResourceIds);
  }

  async refresh(preparationId: string): Promise<{ status: string; action: string }> {
    const rows = await this.db
      .select()
      .from(preparations)
      .where(eq(preparations.id, preparationId))
      .limit(1);
    const prep = rows[0];
    if (!prep || prep.deletedAt) {
      throw Object.assign(new Error('Preparation not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }
    if (prep.targetType !== 'SOCIAL') {
      throw Object.assign(new Error('Refresh only supported for SOCIAL preparations'), {
        statusCode: 400,
        code: 'UNSUPPORTED',
      });
    }

    const now = new Date();
    await this.db
      .update(preparations)
      .set({ status: 'PREPARING', updatedAt: now, revision: prep.revision + 1 })
      .where(eq(preparations.id, preparationId));

    const refreshed = await this.db
      .select()
      .from(preparations)
      .where(eq(preparations.id, preparationId))
      .limit(1);
    const current = refreshed[0]!;
    const ctx = this.buildContext(preparationId, current, [], new Set());
    const action = await refreshSocialPreparation(ctx, {
      db: this.db,
      places: this.places,
      distance: this.distance,
    });
    if (action === 'unchanged') {
      await this.db
        .update(preparations)
        .set({
          status: 'READY',
          updatedAt: new Date(),
          revision: current.revision + 1,
          lastPreparedAt: new Date(),
        })
        .where(eq(preparations.id, preparationId));
    }
    const after = await this.getById(preparationId);
    return { status: after?.preparation.status ?? 'UNKNOWN', action };
  }

  private async executePipeline(
    preparationId: string,
    excludeResourceIds: string[],
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(preparations)
      .where(eq(preparations.id, preparationId))
      .limit(1);
    const prep = rows[0];
    if (!prep || prep.deletedAt) return;

    const now = new Date();
    if (prep.status !== 'PREPARING') {
      await this.db
        .update(preparations)
        .set({ status: 'PREPARING', updatedAt: now, revision: prep.revision + 1 })
        .where(eq(preparations.id, preparationId));
    }

    const excludeUrls = new Set<string>();
    if (excludeResourceIds.length > 0) {
      const excluded = await this.db
        .select()
        .from(resources)
        .where(inArray(resources.id, excludeResourceIds));
      for (const r of excluded) {
        if (r.url) excludeUrls.add(r.url);
      }
    }

    const ctx = this.buildContext(preparationId, prep, excludeResourceIds, excludeUrls);

    if (prep.targetType === 'OPPORTUNITY') {
      await runOpportunityPreparation(ctx, {
        db: this.db,
        search: this.search,
        llm: this.llm,
        preferences: this.preferences,
      });
      return;
    }

    if (prep.targetType === 'EXPLORATION') {
      await runExplorationPreparation(ctx, {
        db: this.db,
        search: this.search,
        llm: this.llm,
        preferences: this.preferences,
      });
      return;
    }

    if (prep.targetType === 'SOCIAL') {
      await runSocialPreparation(ctx, {
        db: this.db,
        places: this.places,
        distance: this.distance,
      });
      return;
    }

    if (prep.targetType === 'NEWS') {
      await runNewsPreparation(ctx, {
        db: this.db,
        search: this.search,
        llm: this.llm,
        preferences: this.preferences,
      });
      return;
    }

    await this.runLearningPipeline(ctx);
  }

  private buildContext(
    preparationId: string,
    prep: typeof preparations.$inferSelect,
    excludeResourceIds: string[],
    excludeUrls: Set<string>,
  ): PreparationRunContext {
    return {
      prep,
      preparationId,
      excludeResourceIds,
      excludeUrls,
      fail: (reason) => this.fail(preparationId, reason),
      setNeedsInput: (reason) => this.setNeedsInput(preparationId, prep, reason),
      insertResource: (input) => this.insertResource(input),
      finishReady: (input) => this.finishReady(preparationId, prep, input),
    };
  }

  private async runLearningPipeline(ctx: PreparationRunContext): Promise<void> {
    const { prep, preparationId, excludeResourceIds, excludeUrls, fail, setNeedsInput, insertResource, finishReady } =
      ctx;

    let topic = 'Learning topic';
    let learningItemId: string | null = null;

    if (prep.targetType === 'LEARNING') {
      const li = await this.db
        .select()
        .from(learningItems)
        .where(eq(learningItems.id, prep.targetId))
        .limit(1);
      if (li[0]) {
        topic = li[0].title;
        learningItemId = li[0].id;
      }
    } else {
      const taskRows = await this.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, prep.targetId))
        .limit(1);
      if (taskRows[0]) topic = taskRows[0].title;
    }

    const prefs = await this.preferences.getWeights();
    const maxDuration = prefs.maxDurationMinutes ?? prep.timeBudgetMinutes;

    const profile = await getActiveProfile(this.db);
    const skillBits = profile.skills
      .slice(0, 3)
      .map((s) => `${s.domain} L${s.level}`)
      .join(', ');
    const goalBits = profile.goals
      .filter((g) => g.horizon === 'SHORT')
      .slice(0, 2)
      .map((g) => g.title)
      .join('; ');
    const enrichment = [skillBits && `skills: ${skillBits}`, goalBits && `goals: ${goalBits}`]
      .filter(Boolean)
      .join(' — ');

    const objective = {
      query: enrichment
        ? `${topic} tutorial guide (${enrichment})`
        : `${topic} tutorial guide`,
      topic,
      timeBudgetMinutes: maxDuration,
      preferredFormats: prefs.penalizeVideo ? ['ARTICLE'] : ['ARTICLE', 'VIDEO'],
    };

    let candidates;
    try {
      candidates = await this.search.search(objective);
    } catch (err) {
      await fail(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    candidates = candidates.filter((c) => !excludeUrls.has(c.url));

    if (candidates.length === 0) {
      await setNeedsInput('No alternative sources found after feedback');
      return;
    }

    const ranked = rankCandidates(candidates, objective, prefs);
    for (const c of ranked.slice(0, 10)) {
      await this.db.insert(resourceCandidates).values({
        id: randomUUID(),
        preparationId,
        title: c.title,
        url: c.url,
        snippet: c.snippet,
        score: c.score,
        provider: c.provider,
        searchQuery: objective.query,
        createdAt: new Date().toISOString(),
      });
    }

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
    let attempts = 0;
    while (attempts < 2) {
      try {
        structured = await this.llm.structurePreparation({
          topic,
          timeBudgetMinutes: prep.timeBudgetMinutes,
          candidate: selected,
        });
        break;
      } catch {
        attempts += 1;
      }
    }

    if (!structured) {
      await fail('LLM structuring failed after retries');
      return;
    }

    const resourceId = await insertResource({
      title: selected.title,
      url: urlCheck.url,
      format: selected.url.includes('youtube') ? 'VIDEO' : 'ARTICLE',
      provider: selected.provider,
      snippet: selected.snippet,
      learningItemId,
    });

    await finishReady({
      goal: structured.goal,
      practicePrompt: structured.practicePrompt,
      doneCriteria: structured.doneCriteria,
      selectedResourceId: resourceId,
      backupResourceIds: ranked.slice(1, 3).map((c) => c.url),
      provenance: {
        searchQuery: objective.query,
        provider: selected.provider,
        rankedAt: new Date().toISOString(),
        selectedTitle: selected.title,
        rankReasons: selected.rankReasons.length > 0 ? selected.rankReasons : ['relevance'],
        candidateCount: candidates.length,
        replaced: excludeResourceIds.length > 0,
        excludedCount: excludeResourceIds.length,
      },
      freshnessPolicy: 'STATIC',
    });
  }

  private async insertResource(input: {
    title: string;
    url: string;
    format: string;
    provider: string;
    snippet: string;
    learningItemId: string | null;
    metadata?: ResourceMetadata | null;
  }): Promise<string> {
    const resourceId = randomUUID();
    const preparedAt = new Date();
    await this.db.insert(resources).values({
      id: resourceId,
      title: input.title,
      url: input.url,
      format: input.format,
      provider: input.provider,
      durationMinutes: null,
      notes: input.snippet,
      learningItemId: input.learningItemId,
      metadata: input.metadata ?? null,
      revision: 1,
      updatedAt: preparedAt,
      deletedAt: null,
    });
    return resourceId;
  }

  private async finishReady(
    preparationId: string,
    prep: typeof preparations.$inferSelect,
    input: {
      goal: string;
      practicePrompt: string;
      doneCriteria: string[];
      selectedResourceId: string;
      backupResourceIds: string[];
      provenance: Record<string, unknown>;
      freshnessPolicy: 'STATIC' | 'DAILY' | 'EVENT_BOUND';
    },
  ): Promise<void> {
    const preparedAt = new Date();
    const newRevision = prep.revision + 3;

    await this.db.insert(preparationRevisions).values({
      id: randomUUID(),
      preparationId,
      revision: newRevision,
      snapshot: {
        goal: input.goal,
        practicePrompt: input.practicePrompt,
        doneCriteria: input.doneCriteria,
        selectedResourceId: input.selectedResourceId,
        provenance: input.provenance,
      },
      createdAt: preparedAt,
    });

    await this.db
      .update(preparations)
      .set({
        status: 'READY',
        goal: input.goal,
        practicePrompt: input.practicePrompt,
        doneCriteria: input.doneCriteria,
        selectedResourceId: input.selectedResourceId,
        backupResourceIds: input.backupResourceIds,
        provenance: input.provenance,
        freshnessPolicy: input.freshnessPolicy,
        lastPreparedAt: preparedAt,
        failureReason: null,
        updatedAt: preparedAt,
        revision: newRevision,
      })
      .where(eq(preparations.id, preparationId));

    if (this.notifications) {
      const title = input.goal?.slice(0, 80) || 'Session ready';
      void this.notifications
        .notify({
          type: 'PREP_READY',
          title: 'Preparation ready',
          body: title,
          deepLink: `cos://prepared/${preparationId}`,
          entityType: 'preparation',
          entityId: preparationId,
        })
        .catch(() => undefined);
    }
  }

  private async setNeedsInput(
    preparationId: string,
    prep: typeof preparations.$inferSelect,
    reason: string,
  ): Promise<void> {
    await this.db
      .update(preparations)
      .set({
        status: 'NEEDS_INPUT',
        failureReason: reason,
        updatedAt: new Date(),
        revision: prep.revision + 2,
      })
      .where(eq(preparations.id, preparationId));
  }

  private async fail(preparationId: string, reason: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(preparations)
      .where(eq(preparations.id, preparationId))
      .limit(1);
    const prep = rows[0];
    await this.db
      .update(preparations)
      .set({
        status: 'FAILED',
        failureReason: reason,
        updatedAt: new Date(),
        revision: (prep?.revision ?? 1) + 1,
      })
      .where(eq(preparations.id, preparationId));
  }
}
