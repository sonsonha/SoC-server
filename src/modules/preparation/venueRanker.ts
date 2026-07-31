import type { VenueCandidate } from '../../infrastructure/providers/maps/types.js';

export type RankedVenue = VenueCandidate & { rankReasons: string[]; score: number };

/**
 * Exclude closed venues at target time, then rank by rating + cuisine/vibe match.
 */
export function rankVenues(
  candidates: VenueCandidate[],
  opts: { cuisine?: string[]; vibe?: string[] } = {},
): RankedVenue[] {
  const open = candidates.filter((c) => c.openAtTarget);
  const ranked = open.map((c) => {
    const reasons: string[] = [];
    let score = c.rating * 10;
    reasons.push(`rating:${c.rating}`);

    if (opts.cuisine?.length) {
      const cuisineHit = opts.cuisine.some((tag) =>
        c.cuisineTags.some((t) => t.toLowerCase().includes(tag.toLowerCase())),
      );
      if (cuisineHit) {
        score += 15;
        reasons.push('cuisine-match');
      }
    }

    if (opts.vibe?.length) {
      const vibeHit = opts.vibe.some((tag) =>
        c.vibeTags.some((t) => t.toLowerCase().includes(tag.toLowerCase())),
      );
      if (vibeHit) {
        score += 10;
        reasons.push('vibe-match');
      }
    }

    reasons.push('open-at-target');
    return { ...c, rankReasons: reasons, score };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

const DEFAULT_ARRIVAL_BUFFER_MINUTES = 10;

/**
 * departBy = blockStart - travelMinutes - buffer
 */
export function computeDepartBy(
  blockStart: Date,
  travelMinutes: number,
  bufferMinutes: number = DEFAULT_ARRIVAL_BUFFER_MINUTES,
): Date {
  const ms = (travelMinutes + bufferMinutes) * 60_000;
  return new Date(blockStart.getTime() - ms);
}

export { DEFAULT_ARRIVAL_BUFFER_MINUTES };
