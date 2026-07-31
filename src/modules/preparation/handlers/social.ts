import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../../infrastructure/db/client.js';
import { locations, resources, travelEdges } from '../../../infrastructure/db/schema/index.js';
import type { ResourceMetadata } from '../../../infrastructure/db/schema/resources.js';
import type { PlacesProvider, SocialObjective, VenueCandidate } from '../../../infrastructure/providers/maps/types.js';
import type { DistanceMatrixProvider } from '../../../infrastructure/providers/calendar/types.js';
import {
  computeDepartBy,
  DEFAULT_ARRIVAL_BUFFER_MINUTES,
  rankVenues,
} from '../venueRanker.js';
import type { PreparationRunContext } from './types.js';

export type SocialLogisticsProvenance = {
  searchQuery: string;
  provider: string;
  rankReasons: string[];
  candidateCount: number;
  targetType: 'SOCIAL';
  primaryVenue: {
    placeId: string;
    title: string;
    address: string;
    mapsUrl: string;
    hours: string;
  };
  backupVenue: {
    placeId: string;
    title: string;
    address: string;
    mapsUrl: string;
    hours: string;
  } | null;
  departBy: string;
  travelMinutes: number;
  arrivalBufferMinutes: number;
  fromLocationId: string;
  travelSource?: 'edge' | 'matrix' | 'estimate';
  liveTravelDeltaMinutes?: number;
  replaced?: boolean;
};

function parseSocialObjectiveFromPrep(prep: PreparationRunContext['prep']): SocialObjective {
  const provenance = (prep.provenance ?? {}) as Record<string, unknown>;
  const occasion =
    (provenance.occasion as string | undefined) ??
    (prep.goal || 'Social outing');
  const area = (provenance.area as string | undefined) ?? 'Singapore';
  const cuisine = provenance.cuisine as string[] | undefined;
  const vibe = provenance.vibe as string[] | undefined;
  const budget = provenance.budget as SocialObjective['budget'] | undefined;
  return {
    occasion,
    datetime: prep.scheduledStartAt,
    area,
    cuisine,
    vibe,
    budget,
  };
}

async function resolveTravelMinutes(
  db: Db,
  fromLocationId: string,
  venue: VenueCandidate,
  distance?: DistanceMatrixProvider,
  origin?: { lat: number; lng: number },
): Promise<{ minutes: number; source: 'edge' | 'matrix' | 'estimate'; liveDelta?: number }> {
  const edges = await db
    .select()
    .from(travelEdges)
    .where(and(eq(travelEdges.fromLocationId, fromLocationId), isNull(travelEdges.deletedAt)));

  let edgeMinutes = venue.travelMinutesEstimate;
  if (edges.length > 0) {
    const minEdge = edges.reduce((a, b) => (a.typicalMinutes < b.typicalMinutes ? a : b));
    edgeMinutes = Math.max(venue.travelMinutesEstimate, minEdge.typicalMinutes);
  }

  if (distance && origin && venue.lat != null && venue.lng != null) {
    const live = await distance.travelMinutes({
      originLat: origin.lat,
      originLng: origin.lng,
      destLat: venue.lat,
      destLng: venue.lng,
    });
    return {
      minutes: live,
      source: 'matrix',
      liveDelta: live - edgeMinutes,
    };
  }

  return {
    minutes: edgeMinutes,
    source: edges.length > 0 ? 'edge' : 'estimate',
  };
}

function venueToMetadata(v: VenueCandidate, isBackup: boolean): ResourceMetadata {
  return {
    placeId: v.placeId,
    address: v.address,
    hours: v.hoursSummary,
    mapsUrl: v.mapsUrl,
    cuisine: v.cuisineTags,
    vibe: v.vibeTags,
    rating: v.rating,
    isBackup,
  };
}

export async function runSocialPreparation(
  ctx: PreparationRunContext,
  deps: {
    db: Db;
    places: PlacesProvider;
    distance?: DistanceMatrixProvider;
    fromLocationId?: string;
  },
): Promise<void> {
  const { prep, excludeUrls, fail, insertResource, finishReady } = ctx;
  const { db, places } = deps;
  const fromLocationId = deps.fromLocationId ?? 'loc-home';
  const objective = parseSocialObjectiveFromPrep(prep);

  let candidates: VenueCandidate[];
  try {
    candidates = await places.searchVenues(objective);
  } catch (err) {
    await fail(`Places search failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  candidates = candidates.filter((c) => !excludeUrls.has(c.mapsUrl) && !excludeUrls.has(c.placeId));
  const ranked = rankVenues(candidates, {
    cuisine: objective.cuisine,
    vibe: objective.vibe,
  });

  if (ranked.length === 0) {
    await ctx.setNeedsInput('No open venues found for the requested time and constraints');
    return;
  }

  const primary = ranked[0];
  const backup = ranked.find((v) => v.placeId !== primary.placeId) ?? null;
  if (!backup) {
    await ctx.setNeedsInput('Need at least two open venues (primary + backup)');
    return;
  }

  const originRows = await db
    .select()
    .from(locations)
    .where(and(eq(locations.id, fromLocationId), isNull(locations.deletedAt)))
    .limit(1);
  const origin =
    originRows[0]?.latitude != null && originRows[0]?.longitude != null
      ? { lat: originRows[0].latitude, lng: originRows[0].longitude }
      : undefined;

  const travel = await resolveTravelMinutes(db, fromLocationId, primary, deps.distance, origin);
  const travelMinutes = travel.minutes;
  const departBy = computeDepartBy(prep.scheduledStartAt, travelMinutes, DEFAULT_ARRIVAL_BUFFER_MINUTES);

  const primaryId = await insertResource({
    title: primary.title,
    url: primary.mapsUrl,
    format: 'VENUE',
    provider: primary.provider,
    snippet: `${primary.address} · ${primary.hoursSummary}`,
    learningItemId: null,
    metadata: venueToMetadata(primary, false),
  });

  const backupId = await insertResource({
    title: backup.title,
    url: backup.mapsUrl,
    format: 'VENUE',
    provider: backup.provider,
    snippet: `${backup.address} · ${backup.hoursSummary}`,
    learningItemId: null,
    metadata: venueToMetadata(backup, true),
  });

  const logistics: SocialLogisticsProvenance = {
    searchQuery: `${objective.occasion} ${objective.area}`,
    provider: primary.provider,
    rankReasons: primary.rankReasons,
    candidateCount: candidates.length,
    targetType: 'SOCIAL',
    primaryVenue: {
      placeId: primary.placeId,
      title: primary.title,
      address: primary.address,
      mapsUrl: primary.mapsUrl,
      hours: primary.hoursSummary,
    },
    backupVenue: {
      placeId: backup.placeId,
      title: backup.title,
      address: backup.address,
      mapsUrl: backup.mapsUrl,
      hours: backup.hoursSummary,
    },
    departBy: departBy.toISOString(),
    travelMinutes,
    arrivalBufferMinutes: DEFAULT_ARRIVAL_BUFFER_MINUTES,
    fromLocationId,
    travelSource: travel.source,
    liveTravelDeltaMinutes: travel.liveDelta,
    replaced: ctx.excludeResourceIds.length > 0,
  };

  await finishReady({
    goal:
      prep.goal ||
      `Enjoy ${objective.occasion} near ${objective.area}`,
    practicePrompt: `Depart by ${departBy.toLocaleTimeString('en-SG', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Singapore',
    })} (${travelMinutes + DEFAULT_ARRIVAL_BUFFER_MINUTES} min travel+buffer). Backup ready if wait > 20 min.`,
    doneCriteria: [
      `Arrive by ${prep.scheduledStartAt.toLocaleTimeString('en-SG', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Singapore',
      })}`,
      'Confirm primary venue hours still hold',
      'Backup ready if wait > 20min',
    ],
    selectedResourceId: primaryId,
    backupResourceIds: [backupId],
    provenance: logistics,
    freshnessPolicy: 'EVENT_BOUND',
  });
}

/**
 * Day-of refresh: re-check primary hours; promote backup if closed.
 */
export async function refreshSocialPreparation(
  ctx: PreparationRunContext,
  deps: {
    db: Db;
    places: PlacesProvider;
    distance?: DistanceMatrixProvider;
    fromLocationId?: string;
  },
): Promise<'unchanged' | 'promoted_backup' | 'rerun'> {
  const { prep, preparationId } = ctx;
  const { db, places } = deps;
  const provenance = (prep.provenance ?? {}) as Partial<SocialLogisticsProvenance>;
  const primaryPlaceId = provenance.primaryVenue?.placeId;
  if (!primaryPlaceId || !prep.selectedResourceId) {
    await runSocialPreparation(ctx, deps);
    return 'rerun';
  }

  const open = await places.isOpenAt(primaryPlaceId, prep.scheduledStartAt);
  if (open) return 'unchanged';

  const backupIds = prep.backupResourceIds ?? [];
  const backupId = backupIds[0];
  if (!backupId) {
    await runSocialPreparation(ctx, deps);
    return 'rerun';
  }

  const backupRows = await db.select().from(resources).where(eq(resources.id, backupId)).limit(1);
  const backup = backupRows[0];
  if (!backup) {
    await runSocialPreparation(ctx, deps);
    return 'rerun';
  }

  const meta = (backup.metadata ?? {}) as ResourceMetadata;
  const newProvenance: SocialLogisticsProvenance = {
    searchQuery: provenance.searchQuery ?? '',
    provider: provenance.provider ?? backup.provider,
    rankReasons: ['promoted-backup', 'primary-closed'],
    candidateCount: provenance.candidateCount ?? 1,
    targetType: 'SOCIAL',
    primaryVenue: {
      placeId: meta.placeId ?? backup.id,
      title: backup.title,
      address: meta.address ?? '',
      mapsUrl: meta.mapsUrl ?? backup.url ?? '',
      hours: meta.hours ?? '',
    },
    backupVenue: null,
    departBy: provenance.departBy ?? prep.scheduledStartAt.toISOString(),
    travelMinutes: provenance.travelMinutes ?? 25,
    arrivalBufferMinutes: provenance.arrivalBufferMinutes ?? DEFAULT_ARRIVAL_BUFFER_MINUTES,
    fromLocationId: provenance.fromLocationId ?? 'loc-home',
    replaced: true,
  };

  await ctx.finishReady({
    goal: prep.goal,
    practicePrompt: `Primary was closed — using backup: ${backup.title}`,
    doneCriteria: prep.doneCriteria as string[],
    selectedResourceId: backup.id,
    backupResourceIds: [],
    provenance: newProvenance,
    freshnessPolicy: 'EVENT_BOUND',
  });

  void preparationId;
  return 'promoted_backup';
}
