import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import {
  dailyPlans,
  learningItems,
  learningTracks,
  planBlocks,
  preparations,
  seasons,
  tasks,
} from '../../infrastructure/db/schema/index.js';
import { getActiveProfile } from '../../application/syncService.js';
import type {
  CreateTracksBody,
  LearningRecommendation,
} from '../../domain/learning.js';
import type { JobQueue } from '../../infrastructure/jobs/jobQueue.js';

const CATALOG: Array<Omit<LearningRecommendation, 'reason'> & { reasonFor: (ctx: RecContext) => string | null }> = [
  {
    id: 'rec-english-interview',
    title: 'English for interviews',
    lifeArea: 'INTELLECTUAL',
    topic: 'English interview speaking practice',
    suggestedTargetPerWeek: 3,
    priority: 4,
    definitionOfProgress: 'Hold a 5-minute mock answer without reading notes',
    reasonFor: (ctx) => {
      const skill = ctx.skills.find((s) => /english/i.test(s.domain));
      if (skill && skill.level <= 2) return `English skill is level ${skill.level} — raise consistency`;
      if (ctx.chapter === 'APPLYING_ABROAD') return 'APPLYING_ABROAD chapter needs stronger English';
      if (ctx.goals.some((g) => /english/i.test(g.title))) return 'Matches your English goal';
      return null;
    },
  },
  {
    id: 'rec-systems-interview',
    title: 'Systems interview foundations',
    lifeArea: 'CAREER',
    topic: 'TCP reliability OS networking interview',
    suggestedTargetPerWeek: 2,
    priority: 4,
    definitionOfProgress: 'Explain TCP retransmission and flow control in your own words',
    reasonFor: (ctx) => {
      const skill = ctx.skills.find((s) => /system|network/i.test(s.domain));
      if (skill && skill.level <= 2) return `Systems skill is level ${skill.level}`;
      if (ctx.goals.some((g) => /career|interview|capital/i.test(g.title))) {
        return 'Supports career capital / interview readiness';
      }
      return ctx.chapter === 'WORKING' ? 'Career depth while working' : null;
    },
  },
  {
    id: 'rec-cv-perception',
    title: 'CV / perception for demo',
    lifeArea: 'CORE_WORK',
    topic: 'computer vision YOLO segmentation Jetson',
    suggestedTargetPerWeek: 2,
    priority: 5,
    definitionOfProgress: 'Ship one measurable perception improvement toward demo',
    reasonFor: (ctx) => {
      if (ctx.goals.some((g) => /rover|demo|cv|perception/i.test(g.title))) {
        return 'Linked to your rover / demo goal';
      }
      if (ctx.projects.some((p) => /rover|drone|cv/i.test(p.title))) {
        return `Supports project ${ctx.projects.find((p) => /rover|drone|cv/i.test(p.title))?.title}`;
      }
      const skill = ctx.skills.find((s) => /vision|cv/i.test(s.domain));
      if (skill && skill.level <= 3) return `Computer vision at level ${skill.level} — deepen for proof`;
      return null;
    },
  },
  {
    id: 'rec-scholarship-literacy',
    title: 'Scholarship / fellowship literacy',
    lifeArea: 'OPPORTUNITY',
    topic: 'scholarship fellowship application essays eligibility',
    suggestedTargetPerWeek: 2,
    priority: 4,
    definitionOfProgress: 'Draft one eligibility checklist for a target program',
    reasonFor: (ctx) => {
      if (ctx.chapter === 'APPLYING_ABROAD') return 'Chapter APPLYING_ABROAD — application readiness';
      if (ctx.goals.some((g) => /abroad|scholarship|fellow|master|phd/i.test(g.title))) {
        return 'Matches an abroad / research goal';
      }
      return null;
    },
  },
  {
    id: 'rec-os-fundamentals',
    title: 'Operating systems fundamentals',
    lifeArea: 'INTELLECTUAL',
    topic: 'operating systems processes threads scheduling',
    suggestedTargetPerWeek: 2,
    priority: 3,
    definitionOfProgress: 'Summarize process vs thread and scheduling basics',
    reasonFor: (ctx) => {
      if (ctx.learningTitles.some((t) => /operating system|\bos\b/i.test(t))) {
        return 'Already on your learning queue';
      }
      const skill = ctx.skills.find((s) => /system/i.test(s.domain));
      if (skill && skill.level <= 2) return 'Fills systems fundamentals gap';
      return null;
    },
  },
];

type RecContext = {
  chapter: string;
  goals: Array<{ id: string; title: string; lifeArea: string }>;
  skills: Array<{ id: string; domain: string; level: number }>;
  projects: Array<{ title: string; lifeArea: string }>;
  learningTitles: string[];
};

function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Prefer Mon/Wed/Fri then Tue/Thu for spacing. */
function preferredSessionDates(weekStart: string, count: number): string[] {
  const offsets = [0, 2, 4, 1, 3, 5, 6];
  return offsets.slice(0, Math.min(count, 7)).map((o) => addDays(weekStart, o));
}

export class LearningCurriculumService {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
  ) {}

  async recommendations(): Promise<LearningRecommendation[]> {
    const profile = await getActiveProfile(this.db);
    const learningRows = await this.db
      .select()
      .from(learningItems)
      .where(isNull(learningItems.deletedAt))
      .limit(20);
    const ctx: RecContext = {
      chapter: profile.profile?.chapter ?? 'WORKING',
      goals: profile.goals.map((g) => ({ id: g.id, title: g.title, lifeArea: g.lifeArea })),
      skills: profile.skills.map((s) => ({ id: s.id, domain: s.domain, level: s.level })),
      projects: profile.projects.map((p) => ({ title: p.title, lifeArea: p.lifeArea })),
      learningTitles: learningRows.map((l) => l.title),
    };

    const active = await this.listTracks();
    const activeRecIds = new Set(active.map((t) => t.recommendationId).filter(Boolean));

    const out: LearningRecommendation[] = [];
    for (const item of CATALOG) {
      if (activeRecIds.has(item.id)) continue;
      const reason = item.reasonFor(ctx);
      if (!reason) continue;
      const skill = ctx.skills.find((s) =>
        item.lifeArea === 'INTELLECTUAL' && /english/i.test(item.topic)
          ? /english/i.test(s.domain)
          : item.topic.toLowerCase().includes(s.domain.toLowerCase().split(' ')[0] ?? ''),
      );
      const goal = ctx.goals.find((g) => reason.toLowerCase().includes(g.title.toLowerCase().slice(0, 12)));
      out.push({
        id: item.id,
        title: item.title,
        lifeArea: item.lifeArea,
        topic: item.topic,
        reason,
        suggestedTargetPerWeek: item.suggestedTargetPerWeek,
        priority: item.priority,
        goalId: goal?.id ?? null,
        skillId: skill?.id ?? null,
        definitionOfProgress: item.definitionOfProgress,
      });
    }

    // Always offer at least one career or intellectual fallback from goals
    if (out.length === 0 && ctx.goals[0]) {
      const g = ctx.goals[0];
      out.push({
        id: `rec-goal-${g.id}`,
        title: `Learn toward: ${g.title}`,
        lifeArea: g.lifeArea,
        topic: g.title,
        reason: 'Derived from your active goal',
        suggestedTargetPerWeek: 2,
        priority: 3,
        goalId: g.id,
        skillId: null,
        definitionOfProgress: `Make measurable progress on ${g.title}`,
      });
    }

    out.sort((a, b) => b.priority - a.priority);
    return out.slice(0, 8);
  }

  async listTracks() {
    const rows = await this.db
      .select()
      .from(learningTracks)
      .where(and(isNull(learningTracks.deletedAt), eq(learningTracks.status, 'ACTIVE')));
    return rows;
  }

  async listTracksWithProgress(weekStart?: string) {
    const start = weekStart ?? mondayOf(new Date());
    const end = addDays(start, 6);
    const tracks = await this.db.select().from(learningTracks).where(isNull(learningTracks.deletedAt));
    const result = [];
    for (const t of tracks) {
      const scheduled = await this.countScheduledSessions(t.id, start, end);
      const completed = await this.countCompletedSessions(t.id, start, end);
      result.push({
        ...t,
        weekStart: start,
        scheduledThisWeek: scheduled,
        completedThisWeek: completed,
      });
    }
    return result;
  }

  async createTracks(body: CreateTracksBody) {
    const recs = await this.recommendations();
    const byId = new Map(recs.map((r) => [r.id, r]));
    // Also allow catalog ids even if filtered out
    for (const c of CATALOG) {
      if (!byId.has(c.id)) {
        byId.set(c.id, {
          id: c.id,
          title: c.title,
          lifeArea: c.lifeArea,
          topic: c.topic,
          reason: 'Selected',
          suggestedTargetPerWeek: c.suggestedTargetPerWeek,
          priority: c.priority,
          definitionOfProgress: c.definitionOfProgress,
        });
      }
    }

    const now = new Date();
    const created: string[] = [];

    for (const recId of body.recommendationIds) {
      const rec = byId.get(recId);
      if (!rec) continue;
      const id = `track-${recId.replace(/^rec-/, '')}`;
      await this.db
        .insert(learningTracks)
        .values({
          id,
          title: rec.title,
          lifeArea: rec.lifeArea,
          topic: rec.topic,
          priority: rec.priority,
          targetPerWeek: rec.suggestedTargetPerWeek,
          horizon: 'WEEK',
          status: 'ACTIVE',
          goalId: rec.goalId ?? null,
          skillId: rec.skillId ?? null,
          definitionOfProgress: rec.definitionOfProgress ?? '',
          recommendationId: rec.id,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: learningTracks.id,
          set: {
            status: 'ACTIVE',
            title: rec.title,
            topic: rec.topic,
            targetPerWeek: rec.suggestedTargetPerWeek,
            updatedAt: now,
            deletedAt: null,
          },
        });
      created.push(id);
    }

    for (const c of body.custom) {
      const id = `track-custom-${randomUUID().slice(0, 8)}`;
      await this.db.insert(learningTracks).values({
        id,
        title: c.title,
        lifeArea: c.lifeArea,
        topic: c.topic,
        priority: c.priority ?? 3,
        targetPerWeek: c.targetPerWeek ?? 2,
        horizon: 'WEEK',
        status: 'ACTIVE',
        goalId: null,
        skillId: null,
        definitionOfProgress: c.definitionOfProgress ?? '',
        recommendationId: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
      created.push(id);
    }

    await this.ensureCadenceForWeek(mondayOf(new Date()));
    return { trackIds: created };
  }

  async ensureCadenceForWeek(weekStart: string): Promise<{ scheduled: number }> {
    const tracks = await this.listTracks();
    tracks.sort((a, b) => b.priority - a.priority);
    let scheduled = 0;
    const end = addDays(weekStart, 6);

    for (const track of tracks) {
      const existing = await this.countScheduledSessions(track.id, weekStart, end);
      const need = Math.max(0, track.targetPerWeek - existing);
      if (need === 0) continue;
      const dates = preferredSessionDates(weekStart, track.targetPerWeek);
      for (const date of dates) {
        const current = await this.countScheduledSessions(track.id, weekStart, end);
        if (current >= track.targetPerWeek) break;
        if (await this.hasSessionOnDate(track.id, date)) continue;
        await this.scheduleSession(track, date);
        scheduled += 1;
      }
    }
    return { scheduled };
  }

  private sessionLearningId(trackId: string, date: string) {
    return `li-${trackId}-${date}`;
  }

  private sessionTaskId(trackId: string, date: string) {
    return `task-${trackId}-${date}`;
  }

  private async hasSessionOnDate(trackId: string, date: string): Promise<boolean> {
    const id = this.sessionLearningId(trackId, date);
    const rows = await this.db.select().from(learningItems).where(eq(learningItems.id, id)).limit(1);
    return rows.length > 0 && !rows[0].deletedAt;
  }

  private async countScheduledSessions(trackId: string, weekStart: string, weekEnd: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(learningItems)
      .where(and(isNull(learningItems.deletedAt)));
    return rows.filter((r) => {
      if (!r.id.startsWith(`li-${trackId}-`)) return false;
      const date = r.id.slice(`li-${trackId}-`.length);
      return date >= weekStart && date <= weekEnd;
    }).length;
  }

  private async countCompletedSessions(trackId: string, weekStart: string, weekEnd: string): Promise<number> {
    const taskRows = await this.db.select().from(tasks).where(isNull(tasks.deletedAt));
    return taskRows.filter((t) => {
      if (!t.id.startsWith(`task-${trackId}-`)) return false;
      if (t.status !== 'DONE') return false;
      const date = t.id.slice(`task-${trackId}-`.length);
      return date >= weekStart && date <= weekEnd;
    }).length;
  }

  private async scheduleSession(
    track: typeof learningTracks.$inferSelect,
    date: string,
  ): Promise<void> {
    const now = new Date();
    const learningId = this.sessionLearningId(track.id, date);
    const taskId = this.sessionTaskId(track.id, date);
    const planId = `plan-${date}`;
    const blockId = `block-${date}-${track.id}`;
    const preparationId = randomUUID();

    await this.db
      .insert(learningItems)
      .values({
        id: learningId,
        title: track.title,
        why: `Track ${track.id} · ${track.definitionOfProgress || track.topic}`,
        source: 'learning_track',
        tier: 'NOW',
        estimatedMinutes: 45,
        definitionOfDone: track.definitionOfProgress || `Make progress on ${track.topic}`,
        sortOrder: 0,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: learningItems.id,
        set: { title: track.title, updatedAt: now, deletedAt: null },
      });

    await this.db
      .insert(tasks)
      .values({
        id: taskId,
        title: track.title,
        description: `learning_track:${track.id}`,
        projectId: null,
        lifeArea: track.lifeArea,
        priority: track.priority,
        deadlineEpochMs: null,
        estimatedMinutes: 45,
        actualMinutes: null,
        energyRequirement: 2,
        locationRequirements: '["laptop","reading"]',
        dependencyIds: '[]',
        preferredTime: null,
        earliestStartEpochMs: null,
        deadlineFlexible: true,
        interruptible: true,
        deepWork: true,
        nextAction: track.topic,
        rescheduleCount: 0,
        status: 'TODO',
        verificationLevel: 'SELF',
        isAnchorCandidate: true,
        estimateBiasFactor: 1,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: tasks.id,
        set: { title: track.title, status: 'TODO', updatedAt: now, deletedAt: null },
      });

    const seasonRows = await this.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.active, true), isNull(seasons.deletedAt)))
      .limit(1);
    const mainOutcome = seasonRows[0]?.title ?? 'Make meaningful progress today';

    await this.db
      .insert(dailyPlans)
      .values({
        id: planId,
        date,
        mainOutcome,
        anchorTaskIds: [taskId],
        briefing: null,
        bufferMinutes: 30,
        hardStopNotes: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: dailyPlans.id,
        set: { updatedAt: now, deletedAt: null },
      });

    const existingBlocks = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));
    const cosCount = existingBlocks.filter((b) => b.ownership === 'COS').length;
    const [y, m, d] = date.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, d, Math.min(14 + cosCount, 20), 0, 0));
    const end = new Date(start.getTime() + 45 * 60_000);

    await this.db.insert(preparations).values({
      id: preparationId,
      targetType: 'LEARNING',
      targetId: learningId,
      status: 'PENDING',
      scheduledStartAt: start,
      timeBudgetMinutes: 45,
      goal: track.definitionOfProgress || track.topic,
      practicePrompt: '',
      doneCriteria: track.definitionOfProgress ? [track.definitionOfProgress] : [],
      selectedResourceId: null,
      backupResourceIds: [],
      provenance: { trackId: track.id, topic: track.topic },
      freshnessPolicy: 'STATIC',
      lastPreparedAt: null,
      failureReason: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    await this.db
      .insert(planBlocks)
      .values({
        id: blockId,
        dailyPlanId: planId,
        date,
        startEpochMs: start.getTime(),
        endEpochMs: end.getTime(),
        type: 'TASK',
        ownership: 'COS',
        title: track.title,
        taskId,
        habitId: null,
        commitmentId: null,
        locationId: 'loc-home',
        locked: false,
        preparationId,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: planBlocks.id,
        set: {
          title: track.title,
          taskId,
          preparationId,
          startEpochMs: start.getTime(),
          endEpochMs: end.getTime(),
          updatedAt: now,
          deletedAt: null,
        },
      });

    this.jobs.enqueue('preparation.run', { preparationId });
  }

  /** After completion — suggest skill bump if track linked to a skill. */
  async skillSuggestionForTask(taskId: string): Promise<{
    skillId: string;
    domain: string;
    from: number;
    to: number;
  } | null> {
    const m = taskId.match(/^task-(track-.+)-\d{4}-\d{2}-\d{2}$/);
    if (!m) return null;
    const trackId = m[1];
    const tracks = await this.db
      .select()
      .from(learningTracks)
      .where(eq(learningTracks.id, trackId))
      .limit(1);
    const track = tracks[0];
    if (!track?.skillId) return null;
    const profile = await getActiveProfile(this.db);
    const skill = profile.skills.find((s) => s.id === track.skillId);
    if (!skill || skill.level >= 5) return null;
    return {
      skillId: skill.id,
      domain: skill.domain,
      from: skill.level,
      to: Math.min(5, skill.level + 1),
    };
  }
}
