import { randomUUID } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import { resolveLegacyPlannerOwnerUserId } from '../modules/identity/legacyPlannerOwner.js';
import {
  inboxItems,
  learningItems,
  opportunities,
  preparations,
  profileStatus,
  skillLevels,
  tasks,
  travelEdges,
} from '../infrastructure/db/schema/index.js';
import { intakeInterpretationSchema } from '../domain/intake.js';
import type { ClarifyRequest } from '../domain/intake.js';
import type { LlmProvider } from '../infrastructure/providers/llm/types.js';
import type { JobQueue } from '../infrastructure/jobs/jobQueue.js';
import { PeopleService } from '../modules/people/peopleService.js';
import { WaitingService } from '../modules/waiting/waitingService.js';
import { DecisionService } from '../modules/decisions/decisionService.js';
import { getActiveProfile } from './syncService.js';

export type IntakeInput = {
  text: string;
  capturedAt?: string;
  locationId?: string;
};

function extractMinutesHeuristic(text: string): number {
  const m = text.match(/(\d+)\s*(?:min(?:ute)?s?|m\b)/i);
  if (m) return Math.min(180, Math.max(5, Number(m[1])));
  return 45;
}

function extractPersonName(text: string): string | null {
  const m = text.match(/waiting on ([A-Z][a-z]+)/i) ?? text.match(/waiting for ([A-Z][a-z]+)/i);
  return m?.[1] ?? null;
}

function heuristicInterpret(text: string) {
  const lower = text.toLowerCase();
  const minutes = extractMinutesHeuristic(text);

  if (/\bwaiting on\b|\bwaiting for\b/i.test(text)) {
    const personName = extractPersonName(text) ?? 'Someone';
    const title = text.replace(/^waiting on [A-Z][a-z]+\s+(to\s+)?/i, '').slice(0, 120) || 'Pending item';
    return intakeInterpretationSchema.parse({
      kind: 'WAITING',
      title,
      lifeArea: 'CORE_WORK',
      needsConfirm: false,
      person: { name: personName, relationship: 'colleague' },
      waitingItem: { title, waitingOn: personName, followUpDays: 3 },
      task: { title, status: 'WAITING' },
    });
  }

  if (/\bdecide\b|\bdecision\b|\bvs\.?\b/i.test(lower)) {
    const options = text.match(/(.+?)\s+vs\.?\s+(.+)/i);
    const decisionOptions = options
      ? [{ label: options[1].replace(/^need to decide:?\s*/i, '').trim() }, { label: options[2].trim() }]
      : [{ label: 'Option A' }, { label: 'Option B' }];
    return intakeInterpretationSchema.parse({
      kind: 'DECISION',
      title: text.slice(0, 120),
      lifeArea: 'CAREER',
      needsConfirm: false,
      decisionContext: text,
      decisionOptions,
    });
  }

  if (
    /\bwhat should i know\b|\bexplore\b|\bbefore (my )?(trip|visit|travel)\b|\btech scene\b|\becosystem\b/i.test(
      lower,
    )
  ) {
    const question = text.replace(/^(help me|i want to)\s+/i, '').slice(0, 200);
    return intakeInterpretationSchema.parse({
      kind: 'EXPLORATION',
      title: question || 'Exploration session',
      lifeArea: 'OPPORTUNITY',
      estimatedMinutes: minutes,
      explorationQuestion: question,
      needsConfirm: false,
    });
  }

  if (
    /\bdate night\b|\bdinner\b|\bcoffee with\b|\bmeetup\b|\bnear (marina|jurong)\b|\bquiet cafe\b|\bjapanese\b.*\bnear\b|\bplan .*coffee\b/i.test(
      lower,
    )
  ) {
    const cuisine: string[] = [];
    if (/\bjapanese\b/i.test(lower)) cuisine.push('japanese');
    if (/\bcoffee\b|\bcafe\b/i.test(lower)) cuisine.push('cafe');
    const vibe: string[] = [];
    if (/\bquiet\b/i.test(lower)) vibe.push('quiet');
    if (/\bromantic\b/i.test(lower)) vibe.push('romantic');
    const areaMatch = text.match(/\bnear\s+([A-Za-z][A-Za-z\s]+?)(?:,|\.|$)/i);
    const area = areaMatch?.[1]?.trim() ?? (/\bmarina bay\b/i.test(lower) ? 'Marina Bay' : /\bjurong\b/i.test(lower) ? 'Jurong' : 'Singapore');
    return intakeInterpretationSchema.parse({
      kind: 'SOCIAL',
      title: text.slice(0, 120),
      lifeArea: 'HUMAN',
      estimatedMinutes: minutes || 90,
      socialOccasion: text.slice(0, 120),
      socialArea: area,
      socialCuisine: cuisine.length ? cuisine : undefined,
      socialVibe: vibe.length ? vibe : undefined,
      socialDatetimeHint: /\bfriday\b/i.test(lower)
        ? 'Friday 19:00'
        : /\bsaturday\b/i.test(lower)
          ? 'Saturday 10:00'
          : undefined,
      needsConfirm: false,
    });
  }

  if (
    /\bprepare for\b|\bfellowship\b|\bscholarship\b|\bapplication\b|\bopportunity\b/i.test(lower) &&
    !/\blearn\b/i.test(lower)
  ) {
    const title =
      text.match(/(?:prepare for|applying to)\s+(.+?)(?:\s+this|\s+by|$)/i)?.[1]?.trim() ??
      text.slice(0, 120);
    return intakeInterpretationSchema.parse({
      kind: 'OPPORTUNITY_RESEARCH',
      title: title || 'Opportunity research',
      lifeArea: 'OPPORTUNITY',
      estimatedMinutes: minutes,
      opportunityTitle: title,
      needsConfirm: false,
    });
  }

  const isLearning =
    /\b(learn|learning|study|deep dive|interview)\b/i.test(text) ||
    /\b(tcp|network|reliab)/i.test(lower);

  if (isLearning) {
    const title = text.replace(/^(schedule|i want to)\s+/i, '').slice(0, 120);
    return intakeInterpretationSchema.parse({
      kind: 'LEARNING',
      title: title || 'Learning session',
      lifeArea: 'LEARNING',
      estimatedMinutes: minutes,
      learningTitle: title || 'Learning session',
      needsConfirm: false,
    });
  }
  return null;
}

export class IntakeService {
  private readonly peopleService: PeopleService;
  private readonly waitingService: WaitingService;
  private readonly decisionService: DecisionService;

  constructor(
    private readonly db: Db,
    private readonly llm: LlmProvider,
    private readonly jobs: JobQueue,
  ) {
    this.peopleService = new PeopleService(db);
    this.waitingService = new WaitingService(db);
    this.decisionService = new DecisionService(db);
  }

  private async buildContextPack(): Promise<string> {
    const [profile, learningRows] = await Promise.all([
      getActiveProfile(this.db),
      this.db.select().from(learningItems).limit(5),
    ]);
    const queue = learningRows
      .map((l) => `- ${l.title} (${l.tier}, ${l.estimatedMinutes}m)`)
      .join('\n');
    const shortGoals = profile.goals
      .filter((g) => g.horizon === 'SHORT')
      .map((g) => `- [SHORT] ${g.title} (${g.lifeArea})`)
      .join('\n');
    const longGoals = profile.goals
      .filter((g) => g.horizon === 'LONG')
      .map((g) => `- [LONG] ${g.title} (${g.lifeArea})`)
      .join('\n');
    const skills = profile.skills
      .map((s) => `- ${s.domain}: level ${s.level}${s.notes ? ` (${s.notes})` : ''}`)
      .join('\n');
    const homeWork = profile.travel.find(
      (t) => t.fromLocationId === 'loc-home' && t.toLocationId === 'loc-work',
    );
    const projects = profile.projects.map((p) => `- ${p.title} (${p.lifeArea})`).join('\n');
    const countries = profile.profile?.preferredCountries
      ? (() => {
          try {
            const parsed = JSON.parse(profile.profile.preferredCountries) as string[];
            return Array.isArray(parsed) ? parsed.join(', ') : '';
          } catch {
            return profile.profile.preferredCountries;
          }
        })()
      : '';

    return [
      profile.mission ? `Mission: ${profile.mission.northStar}` : '',
      profile.season
        ? `Season: ${profile.season.title}\n${profile.season.narrative ?? ''}`
        : '',
      profile.profile
        ? `Chapter: ${profile.profile.chapter}\nStatus: ${profile.profile.summary || '(none)'}`
        : '',
      profile.profile?.usualLeaveHome
        ? `Usual leave home: ${profile.profile.usualLeaveHome}`
        : '',
      homeWork ? `Commute home→work: ${homeWork.typicalMinutes} minutes` : '',
      countries ? `Preferred countries: ${countries}` : '',
      shortGoals ? `Short goals:\n${shortGoals}` : '',
      longGoals ? `Long goals:\n${longGoals}` : '',
      skills ? `Skill levels:\n${skills}` : '',
      projects ? `Active projects:\n${projects}` : '',
      queue ? `Learning queue:\n${queue}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async detectClarificationGaps(
    text: string,
    interpretation: ReturnType<typeof intakeInterpretationSchema.parse>,
  ): Promise<Array<{ field: string; question: string }>> {
    const profile = await getActiveProfile(this.db);
    const lower = text.toLowerCase();
    const gaps: Array<{ field: string; question: string }> = [];

    const needsOffice =
      /\boffice\b|\bat work\b|\bworkplace\b|\bmeeting\b.*\b(am|pm|:\d)/i.test(lower) ||
      (/\bleave for work\b|\bcommute\b|\bget to work\b/i.test(lower) &&
        interpretation.kind !== 'LEARNING');
    const homeWork = profile.travel.find(
      (t) => t.fromLocationId === 'loc-home' && t.toLocationId === 'loc-work',
    );
    if (needsOffice && !homeWork) {
      gaps.push({
        field: 'commute_home_work_minutes',
        question: 'How many minutes does it usually take from home to work?',
      });
    }
    if (needsOffice && !profile.profile?.usualLeaveHome && /\bleave\b|\bdepart\b|\bprepare to go\b/i.test(lower)) {
      gaps.push({
        field: 'usual_leave_home',
        question: 'What time do you usually leave home for work? (HH:mm)',
      });
    }

    if (interpretation.kind === 'OPPORTUNITY_RESEARCH') {
      if (/\bscholarship\b|\bfellowship\b|\babroad\b|\bcountry\b/i.test(lower)) {
        if (!profile.profile || profile.profile.chapter !== 'APPLYING_ABROAD') {
          gaps.push({
            field: 'chapter',
            question:
              'What is your current chapter? (STUDENT, WORKING, APPLYING_ABROAD, or OTHER)',
          });
        }
        let countries: string[] = [];
        try {
          countries = JSON.parse(profile.profile?.preferredCountries ?? '[]') as string[];
        } catch {
          countries = [];
        }
        if (!Array.isArray(countries) || countries.length === 0) {
          gaps.push({
            field: 'preferred_countries',
            question: 'Which countries are you considering? (comma-separated)',
          });
        }
      }
    }

    return gaps;
  }

  async clarify(input: ClarifyRequest) {
    const now = new Date();
    for (const answer of input.answers) {
      if (answer.field === 'commute_home_work_minutes') {
        const minutes = Math.min(180, Math.max(5, Number.parseInt(answer.value, 10) || 40));
        const existing = await this.db
          .select()
          .from(travelEdges)
          .where(isNull(travelEdges.deletedAt));
        const forward =
          existing.find((e) => e.fromLocationId === 'loc-home' && e.toLocationId === 'loc-work') ??
          null;
        const reverse =
          existing.find((e) => e.fromLocationId === 'loc-work' && e.toLocationId === 'loc-home') ??
          null;
        const forwardId = forward?.id ?? 'travel-loc-home-loc-work';
        const reverseId = reverse?.id ?? 'travel-loc-work-loc-home';
        await this.db
          .insert(travelEdges)
          .values({
            id: forwardId,
            fromLocationId: 'loc-home',
            toLocationId: 'loc-work',
            typicalMinutes: minutes,
            revision: 1,
            updatedAt: now,
            deletedAt: null,
          })
          .onConflictDoUpdate({
            target: travelEdges.id,
            set: { typicalMinutes: minutes, updatedAt: now, deletedAt: null },
          });
        await this.db
          .insert(travelEdges)
          .values({
            id: reverseId,
            fromLocationId: 'loc-work',
            toLocationId: 'loc-home',
            typicalMinutes: minutes,
            revision: 1,
            updatedAt: now,
            deletedAt: null,
          })
          .onConflictDoUpdate({
            target: travelEdges.id,
            set: { typicalMinutes: minutes, updatedAt: now, deletedAt: null },
          });
      } else if (answer.field === 'usual_leave_home' || answer.field === 'chapter') {
        const existing = await this.db.select().from(profileStatus).limit(1);
        const id = existing[0]?.id ?? 'profile-status';
        const chapter =
          answer.field === 'chapter'
            ? answer.value.toUpperCase().replace(/\s+/g, '_')
            : (existing[0]?.chapter ?? 'WORKING');
        const leave =
          answer.field === 'usual_leave_home'
            ? answer.value
            : (existing[0]?.usualLeaveHome ?? null);
        await this.db
          .insert(profileStatus)
          .values({
            id,
            chapter,
            summary: existing[0]?.summary ?? '',
            usualLeaveHome: leave,
            preferredCountries: existing[0]?.preferredCountries ?? '[]',
            revision: 1,
            updatedAt: now,
            deletedAt: null,
          })
          .onConflictDoUpdate({
            target: profileStatus.id,
            set: {
              chapter,
              usualLeaveHome: leave,
              updatedAt: now,
              deletedAt: null,
            },
          });
      } else if (answer.field === 'preferred_countries') {
        const list = answer.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const existing = await this.db.select().from(profileStatus).limit(1);
        const id = existing[0]?.id ?? 'profile-status';
        await this.db
          .insert(profileStatus)
          .values({
            id,
            chapter: existing[0]?.chapter ?? 'WORKING',
            summary: existing[0]?.summary ?? '',
            usualLeaveHome: existing[0]?.usualLeaveHome ?? null,
            preferredCountries: JSON.stringify(list),
            revision: 1,
            updatedAt: now,
            deletedAt: null,
          })
          .onConflictDoUpdate({
            target: profileStatus.id,
            set: {
              preferredCountries: JSON.stringify(list),
              updatedAt: now,
              deletedAt: null,
            },
          });
      } else if (answer.field === 'skill_domain' || answer.field === 'skill_level') {
        // Combined answers may arrive as "systems:3" on skill_level
        if (answer.field === 'skill_level' && answer.value.includes(':')) {
          const [domain, lvl] = answer.value.split(':');
          const level = Math.min(5, Math.max(1, Number.parseInt(lvl, 10) || 1));
          const id = `skill-${domain.trim().toLowerCase().replace(/\s+/g, '-')}`;
          await this.db
            .insert(skillLevels)
            .values({
              id,
              domain: domain.trim(),
              level,
              notes: null,
              revision: 1,
              updatedAt: now,
              deletedAt: null,
            })
            .onConflictDoUpdate({
              target: skillLevels.id,
              set: { level, domain: domain.trim(), updatedAt: now, deletedAt: null },
            });
        }
      }
    }

    return this.process({
      text: input.text,
      capturedAt: input.capturedAt ?? undefined,
      locationId: input.locationId ?? undefined,
    });
  }

  async process(input: IntakeInput) {
    const context = await this.buildContextPack();
    let interpretation = heuristicInterpret(input.text);
    if (!interpretation) {
      const llmResult = await this.llm.interpretIntake(input.text, context);
      interpretation = intakeInterpretationSchema.parse(llmResult);
    }

    const gaps = await this.detectClarificationGaps(input.text, interpretation);
    if (gaps.length > 0) {
      const inboxId = randomUUID();
      const now = new Date();
      await this.db.insert(inboxItems).values({
        id: inboxId,
        rawText: input.text,
        createdAtEpochMs: now.getTime(),
        parseStatus: 'NEEDS_CONFIRM',
        linkedEntityIds: [],
        parseJson: {
          interpretation,
          clarificationQuestions: gaps,
        },
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
      return {
        inboxItemId: inboxId,
        interpretation: {
          kind: interpretation.kind,
          title: interpretation.title,
          lifeArea: interpretation.lifeArea,
          creates: undefined,
          needsConfirm: true,
          clarificationQuestions: gaps,
        },
        actionsQueued: [] as string[],
      };
    }

    return this.persistInterpretation(input, interpretation);
  }

  private async persistInterpretation(
    input: IntakeInput,
    interpretation: ReturnType<typeof intakeInterpretationSchema.parse>,
  ) {
    const now = new Date();
    const capturedAt = input.capturedAt ? new Date(input.capturedAt) : now;
    const date = capturedAt.toISOString().slice(0, 10);

    const inboxId = randomUUID();
    const learningItemId = randomUUID();
    const taskId = randomUUID();

    const actionsQueued: Array<'plan.generate_day' | 'preparation.run'> = [];
    const linkedIds: string[] = [];

    type CreatesResponse = {
      learningItem?: { id: string; title: string; estimatedMinutes: number };
      task?: { id: string; title: string; estimatedMinutes?: number; status?: string };
      person?: { id: string; name: string; relationship?: string | null };
      waitingItem?: { id: string; title: string; waitingOn?: string | null };
      decision?: { id: string; title: string; optionIds: string[] };
      opportunity?: { id: string; title: string };
      preparation?: { id: string; targetType: string };
      exploration?: { id: string; question: string };
      social?: { id: string; occasion: string; area: string };
    };
    let creates: CreatesResponse | undefined;

    if (interpretation.kind === 'LEARNING') {
      const title = interpretation.learningTitle ?? interpretation.title;
      const minutes = interpretation.estimatedMinutes ?? 45;
      await this.db.insert(learningItems).values({
        id: learningItemId,
        title,
        why: 'Captured via intake',
        source: 'Secretary intake',
        tier: 'NOW',
        estimatedMinutes: minutes,
        definitionOfDone: `Complete focused study on ${title}`,
        sortOrder: 0,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });

      await this.db.insert(tasks).values({
        userId: await resolveLegacyPlannerOwnerUserId(this.db),
        id: taskId,
        title,
        description: input.text,
        projectId: null,
        lifeArea: 'LEARNING',
        priority: 1,
        deadlineEpochMs: null,
        estimatedMinutes: minutes,
        actualMinutes: null,
        energyRequirement: 2,
        locationRequirements: '[]',
        dependencyIds: '[]',
        preferredTime: null,
        earliestStartEpochMs: null,
        deadlineFlexible: true,
        interruptible: true,
        deepWork: true,
        nextAction: `Study ${title}`,
        rescheduleCount: 0,
        status: 'TODO',
        verificationLevel: 'SELF',
        isAnchorCandidate: true,
        estimateBiasFactor: 1,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });

      linkedIds.push(learningItemId, taskId);
      actionsQueued.push('plan.generate_day');
      creates = {
        learningItem: { id: learningItemId, title, estimatedMinutes: minutes },
        task: { id: taskId, title: interpretation.title, estimatedMinutes: minutes },
      };
    } else if (interpretation.kind === 'WAITING') {
      let personId: string | undefined;
      if (interpretation.person) {
        personId = await this.peopleService.findOrCreateByName(
          interpretation.person.name,
          interpretation.person.relationship ?? undefined,
        );
        await this.peopleService.addNote(personId, input.text);
        linkedIds.push(personId);
      }

      const waitingTaskId = randomUUID();
      const waitingTitle = interpretation.waitingItem?.title ?? interpretation.title;
      await this.db.insert(tasks).values({
        userId: await resolveLegacyPlannerOwnerUserId(this.db),
        id: waitingTaskId,
        title: interpretation.task?.title ?? waitingTitle,
        description: input.text,
        projectId: null,
        lifeArea: interpretation.lifeArea,
        priority: 2,
        deadlineEpochMs: null,
        estimatedMinutes: interpretation.estimatedMinutes ?? 30,
        actualMinutes: null,
        energyRequirement: 2,
        locationRequirements: '[]',
        dependencyIds: '[]',
        preferredTime: null,
        earliestStartEpochMs: null,
        deadlineFlexible: true,
        interruptible: true,
        deepWork: false,
        nextAction: `Waiting on ${interpretation.waitingItem?.waitingOn ?? 'response'}`,
        rescheduleCount: 0,
        status: 'WAITING',
        verificationLevel: 'SELF',
        isAnchorCandidate: false,
        estimateBiasFactor: 1,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
      linkedIds.push(waitingTaskId);

      const followUpDays = interpretation.waitingItem?.followUpDays ?? 3;
      const followUpAt = new Date(now.getTime() + followUpDays * 86_400_000);
      const waitingItemId = await this.waitingService.create({
        title: waitingTitle,
        taskId: waitingTaskId,
        waitingOnPersonId: personId,
        waitingOnLabel: interpretation.waitingItem?.waitingOn ?? undefined,
        followUpAt,
      });
      linkedIds.push(waitingItemId);

      creates = {
        person: personId
          ? {
              id: personId,
              name: interpretation.person!.name,
              relationship: interpretation.person!.relationship ?? null,
            }
          : undefined,
        waitingItem: {
          id: waitingItemId,
          title: waitingTitle,
          waitingOn: interpretation.waitingItem?.waitingOn ?? null,
        },
        task: {
          id: waitingTaskId,
          title: interpretation.task?.title ?? waitingTitle,
          status: 'WAITING',
        },
      };
    } else if (interpretation.kind === 'DECISION') {
      const options = (interpretation.decisionOptions ?? [
        { label: 'Option A' },
        { label: 'Option B' },
      ]).map((o) => ({
        label: o.label,
        pros: o.pros ?? undefined,
        cons: o.cons ?? undefined,
      }));
      const { decisionId, optionIds } = await this.decisionService.create({
        title: interpretation.title,
        context: interpretation.decisionContext ?? input.text,
        options,
      });
      linkedIds.push(decisionId, ...optionIds);
      creates = {
        decision: { id: decisionId, title: interpretation.title, optionIds },
      };
    } else if (interpretation.kind === 'TASK') {
      const minutes = interpretation.estimatedMinutes ?? 30;
      await this.db.insert(tasks).values({
        userId: await resolveLegacyPlannerOwnerUserId(this.db),
        id: taskId,
        title: interpretation.title,
        description: input.text,
        projectId: null,
        lifeArea: interpretation.lifeArea,
        priority: 2,
        deadlineEpochMs: null,
        estimatedMinutes: minutes,
        actualMinutes: null,
        energyRequirement: 2,
        locationRequirements: '[]',
        dependencyIds: '[]',
        preferredTime: null,
        earliestStartEpochMs: null,
        deadlineFlexible: true,
        interruptible: true,
        deepWork: false,
        nextAction: interpretation.title,
        rescheduleCount: 0,
        status: 'TODO',
        verificationLevel: 'SELF',
        isAnchorCandidate: false,
        estimateBiasFactor: 1,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
      linkedIds.push(taskId);
      creates = {
        task: { id: taskId, title: interpretation.title, estimatedMinutes: minutes },
      };
    } else if (interpretation.kind === 'OPPORTUNITY_RESEARCH') {
      const oppResult = await this.createOpportunityPrep(input, interpretation, now, date);
      linkedIds.push(...oppResult.linkedIds);
      actionsQueued.push('plan.generate_day', 'preparation.run');
      creates = oppResult.creates;
    } else if (interpretation.kind === 'EXPLORATION') {
      const exploreResult = await this.createExplorationPrep(input, interpretation, now, date);
      linkedIds.push(...exploreResult.linkedIds);
      actionsQueued.push('plan.generate_day', 'preparation.run');
      creates = exploreResult.creates;
    } else if (interpretation.kind === 'SOCIAL') {
      const socialResult = await this.createSocialPrep(input, interpretation, now, date);
      linkedIds.push(...socialResult.linkedIds);
      actionsQueued.push('plan.generate_day', 'preparation.run');
      creates = socialResult.creates;
    }

    await this.db.insert(inboxItems).values({
      id: inboxId,
      rawText: input.text,
      createdAtEpochMs: capturedAt.getTime(),
      parseStatus: 'PARSED',
      linkedEntityIds: linkedIds,
      parseJson: {
        interpretation,
        locationId: input.locationId ?? null,
      },
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    if (interpretation.kind === 'LEARNING') {
      this.jobs.enqueue('plan.generate_day', {
        date,
        taskId,
        learningItemId,
      });
    } else if (interpretation.kind === 'OPPORTUNITY_RESEARCH' && creates?.preparation) {
      this.jobs.enqueue('plan.generate_day', {
        date,
        taskId: creates.task?.id,
      });
      this.jobs.enqueue('preparation.run', { preparationId: creates.preparation.id });
    } else if (interpretation.kind === 'EXPLORATION' && creates?.preparation) {
      this.jobs.enqueue('plan.generate_day', {
        date,
        taskId: creates.task?.id,
      });
      this.jobs.enqueue('preparation.run', { preparationId: creates.preparation.id });
    } else if (interpretation.kind === 'SOCIAL' && creates?.preparation) {
      this.jobs.enqueue('plan.generate_day', {
        date,
        taskId: creates.task?.id,
      });
      this.jobs.enqueue('preparation.run', { preparationId: creates.preparation.id });
    }

    return {
      inboxItemId: inboxId,
      interpretation: {
        kind: interpretation.kind,
        title: interpretation.title,
        lifeArea: interpretation.lifeArea,
        creates,
        needsConfirm: interpretation.needsConfirm,
      },
      actionsQueued,
    };
  }

  private async findOrCreateOpportunity(title: string, now: Date): Promise<string> {
    const existing = await this.db.select().from(opportunities).limit(20);
    const match = existing.find((o) => o.title.toLowerCase().includes(title.toLowerCase().slice(0, 20)));
    if (match) return match.id;

    const id = randomUUID();
    const deadline = now.getTime() + 30 * 86_400_000;
    await this.db.insert(opportunities).values({
      id,
      title,
      description: 'Captured via intake',
      deadlineEpochMs: deadline,
      lastTouchedEpochMs: now.getTime(),
      active: true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    return id;
  }

  private async createOpportunityPrep(
    input: IntakeInput,
    interpretation: ReturnType<typeof intakeInterpretationSchema.parse>,
    now: Date,
    date: string,
  ) {
    const minutes = interpretation.estimatedMinutes ?? 45;
    const oppTitle = interpretation.opportunityTitle ?? interpretation.title;
    const opportunityId = interpretation.opportunityId ?? (await this.findOrCreateOpportunity(oppTitle, now));
    const taskId = randomUUID();
    const preparationId = randomUUID();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 15, 0, 0));

    await this.db.insert(tasks).values({
        userId: await resolveLegacyPlannerOwnerUserId(this.db),
      id: taskId,
      title: `Research: ${oppTitle}`,
      description: input.text,
      projectId: null,
      lifeArea: 'OPPORTUNITY',
      priority: 1,
      deadlineEpochMs: null,
      estimatedMinutes: minutes,
      actualMinutes: null,
      energyRequirement: 2,
      locationRequirements: '[]',
      dependencyIds: '[]',
      preferredTime: null,
      earliestStartEpochMs: null,
      deadlineFlexible: true,
      interruptible: true,
      deepWork: false,
      nextAction: `Review eligibility for ${oppTitle}`,
      rescheduleCount: 0,
      status: 'TODO',
      verificationLevel: 'SELF',
      isAnchorCandidate: false,
      estimateBiasFactor: 1,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    await this.db.insert(preparations).values({
      id: preparationId,
      targetType: 'OPPORTUNITY',
      targetId: opportunityId,
      status: 'PENDING',
      scheduledStartAt: start,
      timeBudgetMinutes: minutes,
      goal: '',
      practicePrompt: '',
      doneCriteria: [],
      selectedResourceId: null,
      backupResourceIds: [],
      provenance: null,
      freshnessPolicy: 'STATIC',
      lastPreparedAt: null,
      failureReason: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    return {
      linkedIds: [opportunityId, taskId, preparationId],
      creates: {
        opportunity: { id: opportunityId, title: oppTitle },
        task: { id: taskId, title: `Research: ${oppTitle}`, estimatedMinutes: minutes },
        preparation: { id: preparationId, targetType: 'OPPORTUNITY' },
      },
    };
  }

  private async createExplorationPrep(
    input: IntakeInput,
    interpretation: ReturnType<typeof intakeInterpretationSchema.parse>,
    now: Date,
    _date: string,
  ) {
    const minutes = interpretation.estimatedMinutes ?? 45;
    const question = interpretation.explorationQuestion ?? interpretation.title;
    const explorationId = `exploration-${randomUUID()}`;
    const taskId = randomUUID();
    const preparationId = randomUUID();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16, 0, 0));

    await this.db.insert(tasks).values({
        userId: await resolveLegacyPlannerOwnerUserId(this.db),
      id: taskId,
      title: question.slice(0, 80),
      description: input.text,
      projectId: null,
      lifeArea: 'OPPORTUNITY',
      priority: 2,
      deadlineEpochMs: null,
      estimatedMinutes: minutes,
      actualMinutes: null,
      energyRequirement: 2,
      locationRequirements: '[]',
      dependencyIds: '[]',
      preferredTime: null,
      earliestStartEpochMs: null,
      deadlineFlexible: true,
      interruptible: true,
      deepWork: false,
      nextAction: question,
      rescheduleCount: 0,
      status: 'TODO',
      verificationLevel: 'SELF',
      isAnchorCandidate: false,
      estimateBiasFactor: 1,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    await this.db.insert(preparations).values({
      id: preparationId,
      targetType: 'EXPLORATION',
      targetId: explorationId,
      status: 'PENDING',
      scheduledStartAt: start,
      timeBudgetMinutes: minutes,
      goal: question,
      practicePrompt: '',
      doneCriteria: [],
      selectedResourceId: null,
      backupResourceIds: [],
      provenance: null,
      freshnessPolicy: 'DAILY',
      lastPreparedAt: null,
      failureReason: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    return {
      linkedIds: [explorationId, taskId, preparationId],
      creates: {
        exploration: { id: explorationId, question },
        task: { id: taskId, title: question.slice(0, 80), estimatedMinutes: minutes },
        preparation: { id: preparationId, targetType: 'EXPLORATION' },
      },
    };
  }

  private nextSocialStart(now: Date, hint?: string): Date {
    const base = new Date(now);
    if (hint && /friday/i.test(hint)) {
      const day = base.getUTCDay();
      const daysUntilFri = (5 - day + 7) % 7 || 7;
      base.setUTCDate(base.getUTCDate() + daysUntilFri);
      base.setUTCHours(11, 0, 0, 0); // 19:00 SGT ≈ 11:00 UTC
      return base;
    }
    if (hint && /saturday/i.test(hint)) {
      const day = base.getUTCDay();
      const daysUntilSat = (6 - day + 7) % 7 || 7;
      base.setUTCDate(base.getUTCDate() + daysUntilSat);
      base.setUTCHours(2, 0, 0, 0); // 10:00 SGT
      return base;
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 0, 0));
  }

  private async createSocialPrep(
    input: IntakeInput,
    interpretation: ReturnType<typeof intakeInterpretationSchema.parse>,
    now: Date,
    _date: string,
  ) {
    const minutes = interpretation.estimatedMinutes ?? 90;
    const occasion = interpretation.socialOccasion ?? interpretation.title;
    const area = interpretation.socialArea ?? 'Singapore';
    const socialId = `social-${randomUUID()}`;
    const taskId = randomUUID();
    const preparationId = randomUUID();
    const start = this.nextSocialStart(now, interpretation.socialDatetimeHint ?? undefined);

    await this.db.insert(tasks).values({
        userId: await resolveLegacyPlannerOwnerUserId(this.db),
      id: taskId,
      title: occasion.slice(0, 80),
      description: input.text,
      projectId: null,
      lifeArea: 'HUMAN',
      priority: 2,
      deadlineEpochMs: start.getTime(),
      estimatedMinutes: minutes,
      actualMinutes: null,
      energyRequirement: 2,
      locationRequirements: '[]',
      dependencyIds: '[]',
      preferredTime: null,
      earliestStartEpochMs: null,
      deadlineFlexible: true,
      interruptible: false,
      deepWork: false,
      nextAction: `Depart for ${area}`,
      rescheduleCount: 0,
      status: 'TODO',
      verificationLevel: 'SELF',
      isAnchorCandidate: false,
      estimateBiasFactor: 1,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    await this.db.insert(preparations).values({
      id: preparationId,
      targetType: 'SOCIAL',
      targetId: socialId,
      status: 'PENDING',
      scheduledStartAt: start,
      timeBudgetMinutes: minutes,
      goal: `Enjoy ${occasion} near ${area}`,
      practicePrompt: '',
      doneCriteria: [],
      selectedResourceId: null,
      backupResourceIds: [],
      provenance: {
        occasion,
        area,
        cuisine: interpretation.socialCuisine ?? [],
        vibe: interpretation.socialVibe ?? [],
        locationId: input.locationId ?? 'loc-home',
      },
      freshnessPolicy: 'EVENT_BOUND',
      lastPreparedAt: null,
      failureReason: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    return {
      linkedIds: [socialId, taskId, preparationId],
      creates: {
        social: { id: socialId, occasion, area },
        task: { id: taskId, title: occasion.slice(0, 80), estimatedMinutes: minutes },
        preparation: { id: preparationId, targetType: 'SOCIAL' },
      },
    };
  }
}
