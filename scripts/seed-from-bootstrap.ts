#!/usr/bin/env tsx
/**
 * Idempotent seed from Android bootstrap profile.json into Postgres.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb, closeDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import {
  goals,
  learningItems,
  locations,
  missions,
  operatingPrinciples,
  opportunities,
  profileStatus,
  projects,
  seasons,
  skillLevels,
  travelEdges,
} from '../src/infrastructure/db/schema/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profilePath = path.resolve(__dirname, '../../app/src/main/assets/bootstrap/profile.json');

type BootstrapProfile = {
  mission: {
    id: string;
    northStar: string;
    freedoms: string[];
    careerHypotheses: string[];
  };
  principles: Array<{ id: string; key: string; title: string; body: string }>;
  season: {
    id: string;
    title: string;
    narrative: string;
    startDate: string;
    endDate: string | null;
    priorityGoalIds: string[];
    active: boolean;
  };
  projects: Array<{
    id: string;
    title: string;
    lifeArea: string;
    description: string;
    active: boolean;
  }>;
  learningQueue: Array<{
    id: string;
    title: string;
    why: string;
    source: string;
    tier: string;
    estimatedMinutes: number;
    definitionOfDone: string;
    sortOrder: number;
  }>;
  locations?: Array<{
    id: string;
    name: string;
    openingHours?: string;
    notes?: string;
  }>;
  travel?: Array<{ from: string; to: string; minutes: number }>;
  goals?: Array<{
    id: string;
    title: string;
    lifeArea: string;
    seasonId?: string | null;
    description?: string;
    horizon?: string;
    status?: string;
    targetDate?: string | null;
  }>;
  skills?: Array<{ id: string; domain: string; level: number; notes?: string | null }>;
  profileStatus?: {
    id: string;
    chapter: string;
    summary?: string;
    usualLeaveHome?: string | null;
    preferredCountries?: string[];
  };
  opportunities?: Array<{
    id: string;
    title: string;
    description: string;
    deadlineEpochMs?: number | null;
    active?: boolean;
  }>;
};

async function main() {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);
  const db = createDb(config.DATABASE_URL);
  const raw = readFileSync(profilePath, 'utf8');
  const profile = JSON.parse(raw) as BootstrapProfile;
  const now = new Date();

  await db
    .insert(missions)
    .values({
      id: profile.mission.id,
      northStar: profile.mission.northStar,
      freedoms: profile.mission.freedoms,
      careerHypotheses: profile.mission.careerHypotheses,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    })
    .onConflictDoUpdate({
      target: missions.id,
      set: {
        northStar: profile.mission.northStar,
        freedoms: profile.mission.freedoms,
        careerHypotheses: profile.mission.careerHypotheses,
        revision: 2,
        updatedAt: now,
      },
    });

  for (const p of profile.principles) {
    await db
      .insert(operatingPrinciples)
      .values({
        id: p.id,
        key: p.key,
        title: p.title,
        body: p.body,
        version: 1,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: operatingPrinciples.id,
        set: {
          key: p.key,
          title: p.title,
          body: p.body,
          revision: 2,
          updatedAt: now,
        },
      });
  }

  await db
    .insert(seasons)
    .values({
      id: profile.season.id,
      title: profile.season.title,
      narrative: profile.season.narrative,
      startDate: profile.season.startDate,
      endDate: profile.season.endDate,
      priorityGoalIds: profile.season.priorityGoalIds,
      active: profile.season.active,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    })
    .onConflictDoUpdate({
      target: seasons.id,
      set: {
        title: profile.season.title,
        narrative: profile.season.narrative,
        startDate: profile.season.startDate,
        endDate: profile.season.endDate,
        priorityGoalIds: profile.season.priorityGoalIds,
        active: profile.season.active,
        revision: 2,
        updatedAt: now,
      },
    });

  for (const proj of profile.projects) {
    await db
      .insert(projects)
      .values({
        id: proj.id,
        title: proj.title,
        lifeArea: proj.lifeArea,
        description: proj.description,
        active: proj.active,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          title: proj.title,
          lifeArea: proj.lifeArea,
          description: proj.description,
          active: proj.active,
          revision: 2,
          updatedAt: now,
        },
      });
  }

  for (const item of profile.learningQueue) {
    await db
      .insert(learningItems)
      .values({
        id: item.id,
        title: item.title,
        why: item.why,
        source: item.source,
        tier: item.tier,
        estimatedMinutes: item.estimatedMinutes,
        definitionOfDone: item.definitionOfDone,
        sortOrder: item.sortOrder,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: learningItems.id,
        set: {
          title: item.title,
          why: item.why,
          source: item.source,
          tier: item.tier,
          estimatedMinutes: item.estimatedMinutes,
          definitionOfDone: item.definitionOfDone,
          sortOrder: item.sortOrder,
          revision: 2,
          updatedAt: now,
        },
      });
  }

  for (const loc of profile.locations ?? []) {
    await db
      .insert(locations)
      .values({
        id: loc.id,
        name: loc.name,
        latitude: null,
        longitude: null,
        openingHours: loc.openingHours ?? null,
        notes: loc.notes ?? null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: locations.id,
        set: {
          name: loc.name,
          openingHours: loc.openingHours ?? null,
          notes: loc.notes ?? null,
          revision: 2,
          updatedAt: now,
        },
      });
  }

  for (const edge of profile.travel ?? []) {
    const id = `travel-${edge.from}-${edge.to}`;
    await db
      .insert(travelEdges)
      .values({
        id,
        fromLocationId: edge.from,
        toLocationId: edge.to,
        typicalMinutes: edge.minutes,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: travelEdges.id,
        set: {
          typicalMinutes: edge.minutes,
          revision: 2,
          updatedAt: now,
        },
      });
  }

  for (const g of profile.goals ?? []) {
    await db
      .insert(goals)
      .values({
        id: g.id,
        title: g.title,
        lifeArea: g.lifeArea,
        seasonId: g.seasonId ?? null,
        description: g.description ?? '',
        horizon: g.horizon ?? 'SHORT',
        status: g.status ?? 'ACTIVE',
        targetDate: g.targetDate ?? null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: goals.id,
        set: {
          title: g.title,
          lifeArea: g.lifeArea,
          seasonId: g.seasonId ?? null,
          description: g.description ?? '',
          horizon: g.horizon ?? 'SHORT',
          status: g.status ?? 'ACTIVE',
          targetDate: g.targetDate ?? null,
          revision: 2,
          updatedAt: now,
          deletedAt: null,
        },
      });
  }

  for (const s of profile.skills ?? []) {
    await db
      .insert(skillLevels)
      .values({
        id: s.id,
        domain: s.domain,
        level: s.level,
        notes: s.notes ?? null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: skillLevels.id,
        set: {
          domain: s.domain,
          level: s.level,
          notes: s.notes ?? null,
          revision: 2,
          updatedAt: now,
          deletedAt: null,
        },
      });
  }

  if (profile.profileStatus) {
    const ps = profile.profileStatus;
    await db
      .insert(profileStatus)
      .values({
        id: ps.id,
        chapter: ps.chapter,
        summary: ps.summary ?? '',
        usualLeaveHome: ps.usualLeaveHome ?? null,
        preferredCountries: JSON.stringify(ps.preferredCountries ?? []),
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: profileStatus.id,
        set: {
          chapter: ps.chapter,
          summary: ps.summary ?? '',
          usualLeaveHome: ps.usualLeaveHome ?? null,
          preferredCountries: JSON.stringify(ps.preferredCountries ?? []),
          revision: 2,
          updatedAt: now,
          deletedAt: null,
        },
      });
  }

  for (const o of profile.opportunities ?? []) {
    await db
      .insert(opportunities)
      .values({
        id: o.id,
        title: o.title,
        description: o.description,
        deadlineEpochMs: o.deadlineEpochMs ?? null,
        lastTouchedEpochMs: now.getTime(),
        active: o.active ?? true,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: opportunities.id,
        set: {
          title: o.title,
          description: o.description,
          deadlineEpochMs: o.deadlineEpochMs ?? null,
          active: o.active ?? true,
          revision: 2,
          updatedAt: now,
          deletedAt: null,
        },
      });
  }

  const missionCount = await db.select({ id: missions.id }).from(missions);
  const learningCount = await db.select({ id: learningItems.id }).from(learningItems);
  console.log(
    `Seed complete: ${missionCount.length} mission(s), ${profile.principles.length} principles, ${profile.projects.length} projects, ${learningCount.length} learning item(s), ${(profile.locations ?? []).length} locations, ${(profile.travel ?? []).length} travel edges, ${(profile.goals ?? []).length} goals, ${(profile.skills ?? []).length} skills, ${(profile.opportunities ?? []).length} opportunities.`,
  );

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
