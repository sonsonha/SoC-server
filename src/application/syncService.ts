import { eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import {
  clientMutations,
  dailyPlans,
  decisionOptions,
  decisions,
  goals,
  inboxItems,
  learningItems,
  learningTracks,
  locations,
  missions,
  opportunities,
  opportunityRequirements,
  people,
  personNotes,
  planBlocks,
  preparations,
  profileStatus,
  projects,
  resourcePreferences,
  resources,
  seasons,
  skillLevels,
  syncCursors,
  tasks,
  travelEdges,
  waitingItems,
} from '../infrastructure/db/schema/index.js';
import { nextCursor, parseSinceCursor, rowToSyncEntity } from '../infrastructure/db/syncHelpers.js';
import type {
  ClientMutation,
  SyncEntity,
  SyncPullResponse,
  SyncPushResponse,
} from '../domain/sync.js';

const SYNC_ENTITY_TYPES = [
  'preparation',
  'resource',
  'daily_plan',
  'plan_block',
  'task',
  'inbox_item',
  'learning_item',
  'resource_preferences',
  'person',
  'person_note',
  'decision',
  'decision_option',
  'waiting_item',
  'opportunity',
  'opportunity_requirement',
  'goal',
  'skill_level',
  'profile_status',
  'travel_edge',
  'location',
  'learning_track',
] as const;

export class SyncService {
  constructor(private readonly db: Db) {}

  async pull(deviceId: string, since: string): Promise<SyncPullResponse> {
    const sinceDate = parseSinceCursor(since);
    const entities: SyncEntity[] = [];

    const [
      prepRows,
      resourceRows,
      planRows,
      blockRows,
      taskRows,
      inboxRows,
      learningRows,
      prefRows,
      peopleRows,
      personNoteRows,
      decisionRows,
      decisionOptionRows,
      waitingRows,
      opportunityRows,
      requirementRows,
      goalRows,
      skillRows,
      profileRows,
      travelRows,
      locationRows,
      trackRows,
    ] = await Promise.all([
      this.db.select().from(preparations).where(gt(preparations.updatedAt, sinceDate)),
      this.db.select().from(resources).where(gt(resources.updatedAt, sinceDate)),
      this.db.select().from(dailyPlans).where(gt(dailyPlans.updatedAt, sinceDate)),
      this.db.select().from(planBlocks).where(gt(planBlocks.updatedAt, sinceDate)),
      this.db.select().from(tasks).where(gt(tasks.updatedAt, sinceDate)),
      this.db.select().from(inboxItems).where(gt(inboxItems.updatedAt, sinceDate)),
      this.db.select().from(learningItems).where(gt(learningItems.updatedAt, sinceDate)),
      this.db.select().from(resourcePreferences).where(gt(resourcePreferences.updatedAt, sinceDate)),
      this.db.select().from(people).where(gt(people.updatedAt, sinceDate)),
      this.db.select().from(personNotes).where(gt(personNotes.updatedAt, sinceDate)),
      this.db.select().from(decisions).where(gt(decisions.updatedAt, sinceDate)),
      this.db.select().from(decisionOptions).where(gt(decisionOptions.updatedAt, sinceDate)),
      this.db.select().from(waitingItems).where(gt(waitingItems.updatedAt, sinceDate)),
      this.db.select().from(opportunities).where(gt(opportunities.updatedAt, sinceDate)),
      this.db
        .select()
        .from(opportunityRequirements)
        .where(gt(opportunityRequirements.updatedAt, sinceDate)),
      this.db.select().from(goals).where(gt(goals.updatedAt, sinceDate)),
      this.db.select().from(skillLevels).where(gt(skillLevels.updatedAt, sinceDate)),
      this.db.select().from(profileStatus).where(gt(profileStatus.updatedAt, sinceDate)),
      this.db.select().from(travelEdges).where(gt(travelEdges.updatedAt, sinceDate)),
      this.db.select().from(locations).where(gt(locations.updatedAt, sinceDate)),
      this.db.select().from(learningTracks).where(gt(learningTracks.updatedAt, sinceDate)),
    ]);

    for (const row of prepRows) entities.push(rowToSyncEntity('preparation', row));
    for (const row of resourceRows) entities.push(rowToSyncEntity('resource', row));
    for (const row of planRows) entities.push(rowToSyncEntity('daily_plan', row));
    for (const row of blockRows) entities.push(rowToSyncEntity('plan_block', row));
    for (const row of taskRows) entities.push(rowToSyncEntity('task', row));
    for (const row of inboxRows) entities.push(rowToSyncEntity('inbox_item', row));
    for (const row of learningRows) entities.push(rowToSyncEntity('learning_item', row));
    for (const row of prefRows) entities.push(rowToSyncEntity('resource_preferences', row));
    for (const row of peopleRows) entities.push(rowToSyncEntity('person', row));
    for (const row of personNoteRows) entities.push(rowToSyncEntity('person_note', row));
    for (const row of decisionRows) entities.push(rowToSyncEntity('decision', row));
    for (const row of decisionOptionRows) entities.push(rowToSyncEntity('decision_option', row));
    for (const row of waitingRows) entities.push(rowToSyncEntity('waiting_item', row));
    for (const row of opportunityRows) entities.push(rowToSyncEntity('opportunity', row));
    for (const row of requirementRows) entities.push(rowToSyncEntity('opportunity_requirement', row));
    for (const row of goalRows) entities.push(rowToSyncEntity('goal', row));
    for (const row of skillRows) entities.push(rowToSyncEntity('skill_level', row));
    for (const row of profileRows) entities.push(rowToSyncEntity('profile_status', row));
    for (const row of travelRows) entities.push(rowToSyncEntity('travel_edge', row));
    for (const row of locationRows) entities.push(rowToSyncEntity('location', row));
    for (const row of trackRows) entities.push(rowToSyncEntity('learning_track', row));

    const existing = await this.db
      .select()
      .from(syncCursors)
      .where(eq(syncCursors.deviceId, deviceId))
      .limit(1);

    const allDates = entities.map((e) => new Date(e.updatedAt));
    const cursor = nextCursor(allDates, existing[0]?.cursor ?? since ?? '0');

    await this.db
      .insert(syncCursors)
      .values({
        deviceId,
        cursor,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: syncCursors.deviceId,
        set: { cursor, updatedAt: new Date() },
      });

    return {
      entities,
      cursor,
      serverTime: new Date().toISOString(),
    };
  }

  async push(deviceId: string, mutations: ClientMutation[]): Promise<SyncPushResponse> {
    const applied: string[] = [];
    const conflicts: Array<{ mutationId: string; reason: string }> = [];

    for (const m of mutations) {
      try {
        await this.db.insert(clientMutations).values({
          mutationId: m.mutationId,
          deviceId,
          entityType: m.entityType,
          entityId: m.entityId,
          operation: m.operation,
          payload: m.payload,
          appliedAt: new Date(),
        });
        await this.applyMutation(m);
        applied.push(m.mutationId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('duplicate') || message.includes('unique') || message.includes('23505')) {
          applied.push(m.mutationId);
        } else {
          conflicts.push({ mutationId: m.mutationId, reason: message });
        }
      }
    }

    const nextCursorValue = String(Date.now());
    await this.db
      .insert(syncCursors)
      .values({
        deviceId,
        cursor: nextCursorValue,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: syncCursors.deviceId,
        set: { cursor: nextCursorValue, updatedAt: new Date() },
      });

    return { applied, conflicts, cursor: nextCursorValue };
  }

  private async applyMutation(m: ClientMutation): Promise<void> {
    const now = new Date();
    const p = m.payload as Record<string, unknown>;

    if (m.entityType === 'mission' && m.operation === 'upsert') {
      if (typeof p.northStar === 'string') {
        await this.db
          .update(missions)
          .set({
            northStar: p.northStar,
            updatedAt: now,
            revision: 1,
          })
          .where(eq(missions.id, m.entityId));
      }
      return;
    }

    if (m.entityType === 'goal' && m.operation === 'upsert') {
      await this.db
        .insert(goals)
        .values({
          id: m.entityId,
          title: String(p.title ?? 'Goal'),
          lifeArea: String(p.life_area ?? p.lifeArea ?? 'INTELLECTUAL'),
          seasonId: (p.season_id ?? p.seasonId) as string | null,
          description: String(p.description ?? ''),
          horizon: String(p.horizon ?? 'SHORT'),
          status: String(p.status ?? 'ACTIVE'),
          targetDate: (p.target_date ?? p.targetDate) as string | null,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: goals.id,
          set: {
            title: String(p.title ?? 'Goal'),
            lifeArea: String(p.life_area ?? p.lifeArea ?? 'INTELLECTUAL'),
            seasonId: (p.season_id ?? p.seasonId) as string | null,
            description: String(p.description ?? ''),
            horizon: String(p.horizon ?? 'SHORT'),
            status: String(p.status ?? 'ACTIVE'),
            targetDate: (p.target_date ?? p.targetDate) as string | null,
            updatedAt: now,
            deletedAt: null,
          },
        });
      return;
    }

    if (m.entityType === 'skill_level' && m.operation === 'upsert') {
      const level = Number(p.level ?? 1);
      await this.db
        .insert(skillLevels)
        .values({
          id: m.entityId,
          domain: String(p.domain ?? 'general'),
          level: Number.isFinite(level) ? Math.min(5, Math.max(1, level)) : 1,
          notes: (p.notes as string | null) ?? null,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: skillLevels.id,
          set: {
            domain: String(p.domain ?? 'general'),
            level: Number.isFinite(level) ? Math.min(5, Math.max(1, level)) : 1,
            notes: (p.notes as string | null) ?? null,
            updatedAt: now,
            deletedAt: null,
          },
        });
      return;
    }

    if (m.entityType === 'profile_status' && m.operation === 'upsert') {
      const countries = p.preferred_countries ?? p.preferredCountries ?? '[]';
      const countriesStr =
        typeof countries === 'string' ? countries : JSON.stringify(countries ?? []);
      await this.db
        .insert(profileStatus)
        .values({
          id: m.entityId,
          chapter: String(p.chapter ?? 'WORKING'),
          summary: String(p.summary ?? ''),
          usualLeaveHome: (p.usual_leave_home ?? p.usualLeaveHome) as string | null,
          preferredCountries: countriesStr,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: profileStatus.id,
          set: {
            chapter: String(p.chapter ?? 'WORKING'),
            summary: String(p.summary ?? ''),
            usualLeaveHome: (p.usual_leave_home ?? p.usualLeaveHome) as string | null,
            preferredCountries: countriesStr,
            updatedAt: now,
            deletedAt: null,
          },
        });
      return;
    }

    if (m.entityType === 'travel_edge' && m.operation === 'upsert') {
      const minutes = Number(p.typical_minutes ?? p.typicalMinutes ?? 30);
      await this.db
        .insert(travelEdges)
        .values({
          id: m.entityId,
          fromLocationId: String(p.from_location_id ?? p.fromLocationId ?? ''),
          toLocationId: String(p.to_location_id ?? p.toLocationId ?? ''),
          typicalMinutes: Number.isFinite(minutes) ? minutes : 30,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: travelEdges.id,
          set: {
            fromLocationId: String(p.from_location_id ?? p.fromLocationId ?? ''),
            toLocationId: String(p.to_location_id ?? p.toLocationId ?? ''),
            typicalMinutes: Number.isFinite(minutes) ? minutes : 30,
            updatedAt: now,
            deletedAt: null,
          },
        });
      return;
    }

    if (m.entityType === 'learning_track' && m.operation === 'upsert') {
      const target = Number(p.target_per_week ?? p.targetPerWeek ?? 2);
      const priority = Number(p.priority ?? 3);
      await this.db
        .insert(learningTracks)
        .values({
          id: m.entityId,
          title: String(p.title ?? 'Learning track'),
          lifeArea: String(p.life_area ?? p.lifeArea ?? 'INTELLECTUAL'),
          topic: String(p.topic ?? p.title ?? ''),
          priority: Number.isFinite(priority) ? priority : 3,
          targetPerWeek: Number.isFinite(target) ? Math.min(7, Math.max(1, target)) : 2,
          horizon: String(p.horizon ?? 'WEEK'),
          status: String(p.status ?? 'ACTIVE'),
          goalId: (p.goal_id ?? p.goalId) as string | null,
          skillId: (p.skill_id ?? p.skillId) as string | null,
          definitionOfProgress: String(
            p.definition_of_progress ?? p.definitionOfProgress ?? '',
          ),
          recommendationId: (p.recommendation_id ?? p.recommendationId) as string | null,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: learningTracks.id,
          set: {
            title: String(p.title ?? 'Learning track'),
            lifeArea: String(p.life_area ?? p.lifeArea ?? 'INTELLECTUAL'),
            topic: String(p.topic ?? p.title ?? ''),
            priority: Number.isFinite(priority) ? priority : 3,
            targetPerWeek: Number.isFinite(target) ? Math.min(7, Math.max(1, target)) : 2,
            horizon: String(p.horizon ?? 'WEEK'),
            status: String(p.status ?? 'ACTIVE'),
            goalId: (p.goal_id ?? p.goalId) as string | null,
            skillId: (p.skill_id ?? p.skillId) as string | null,
            definitionOfProgress: String(
              p.definition_of_progress ?? p.definitionOfProgress ?? '',
            ),
            updatedAt: now,
            deletedAt: null,
          },
        });
      return;
    }

    // soft-delete
    if (m.operation === 'delete') {
      if (m.entityType === 'goal') {
        await this.db
          .update(goals)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(goals.id, m.entityId));
      } else if (m.entityType === 'skill_level') {
        await this.db
          .update(skillLevels)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(skillLevels.id, m.entityId));
      } else if (m.entityType === 'learning_track') {
        await this.db
          .update(learningTracks)
          .set({ deletedAt: now, updatedAt: now, status: 'PAUSED' })
          .where(eq(learningTracks.id, m.entityId));
      }
    }
  }

  static supportedEntityTypes(): readonly string[] {
    return SYNC_ENTITY_TYPES;
  }
}

/** Helpers used by intake clarify / suggestions. */
export async function getActiveProfile(db: Db) {
  const [goalRows, skillRows, profileRows, travelRows, missionRows, seasonRows, projectRows] =
    await Promise.all([
      db.select().from(goals).where(isNull(goals.deletedAt)),
      db.select().from(skillLevels).where(isNull(skillLevels.deletedAt)),
      db.select().from(profileStatus).where(isNull(profileStatus.deletedAt)).limit(1),
      db.select().from(travelEdges).where(isNull(travelEdges.deletedAt)),
      db.select().from(missions).limit(1),
      db.select().from(seasons).limit(1),
      db.select().from(projects).limit(20),
    ]);
  return {
    goals: goalRows.filter((g) => g.status !== 'DONE'),
    skills: skillRows,
    profile: profileRows[0] ?? null,
    travel: travelRows,
    mission: missionRows[0] ?? null,
    season: seasonRows[0] ?? null,
    projects: projectRows.filter((p) => p.active && !p.deletedAt),
  };
}
