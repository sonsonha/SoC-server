import type { SearchCandidate, SearchObjective } from '../../infrastructure/providers/search/types.js';
import type { PreferenceWeights } from '../../infrastructure/db/schema/resourcePreferences.js';

export type RankedCandidate = SearchCandidate & { score: number; rankReasons: string[] };

const AUTHORITY_DOMAINS = [
  'wikipedia.org',
  'developer.mozilla.org',
  'beej.us',
  'hpbn.co',
  'freecodecamp.org',
  'oreilly.com',
  'mit.edu',
  'stanford.edu',
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function relevanceScore(candidate: SearchCandidate, objective: SearchObjective): number {
  const topicTokens = new Set(tokenize(objective.topic));
  const hay = `${candidate.title} ${candidate.snippet}`.toLowerCase();
  let hits = 0;
  for (const t of topicTokens) {
    if (hay.includes(t)) hits += 1;
  }
  return hits;
}

function authorityScore(url: string): number {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (AUTHORITY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return 3;
    if (host.endsWith('.edu') || host.endsWith('.gov')) return 2;
    return 0;
  } catch {
    return -5;
  }
}

function formatScore(
  candidate: SearchCandidate,
  objective: SearchObjective,
  prefs?: PreferenceWeights,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const url = candidate.url.toLowerCase();
  const isVideo = url.includes('youtube.com') || url.includes('youtu.be');
  const preferred = objective.preferredFormats ?? ['ARTICLE'];

  let score = 0;
  if (prefs?.penalizeVideo && isVideo) {
    score -= 8;
    reasons.push('format_penalty_video');
  }
  if (preferred.includes('VIDEO') && isVideo) {
    score += 2;
    reasons.push('format_video');
  }
  if (preferred.includes('ARTICLE') && !isVideo) {
    score += 1;
    reasons.push('format_article');
  }
  if (prefs?.formatWeights) {
    const fmt = isVideo ? 'VIDEO' : 'ARTICLE';
    const w = prefs.formatWeights[fmt] ?? 0;
    score += w * 2;
    if (w > 0) reasons.push(`format_weight_${fmt.toLowerCase()}`);
  }
  return { score, reasons };
}

function durationScore(
  candidate: SearchCandidate,
  prefs?: PreferenceWeights,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const hay = `${candidate.title} ${candidate.snippet}`.toLowerCase();
  const looksLong =
    hay.includes('comprehensive') ||
    hay.includes('full course') ||
    hay.includes('deep dive') ||
    candidate.snippet.length > 200;

  if (prefs?.penalizeLongForm && looksLong) {
    score -= 6;
    reasons.push('duration_too_long');
  }
  if (prefs?.maxDurationMinutes != null && looksLong) {
    score -= 4;
    reasons.push('duration_cap');
  }
  if (!looksLong && prefs?.maxDurationMinutes != null) {
    score += 2;
    reasons.push('duration_match');
  }
  return { score, reasons };
}

function providerScore(candidate: SearchCandidate, prefs?: PreferenceWeights): number {
  if (!prefs?.avoidProviders?.length) return 0;
  if (prefs.avoidProviders.includes(candidate.provider)) return -10;
  return 0;
}

/** Rank search candidates by relevance, authority, format, and user preferences. */
export function rankCandidates(
  candidates: SearchCandidate[],
  objective: SearchObjective,
  prefs?: PreferenceWeights,
): RankedCandidate[] {
  return candidates
    .map((c) => {
      const rel = relevanceScore(c, objective);
      const auth = authorityScore(c.url);
      const fmt = formatScore(c, objective, prefs);
      const dur = durationScore(c, prefs);
      const prov = providerScore(c, prefs);
      const rankReasons = [
        ...(rel > 0 ? ['relevance'] : []),
        ...(auth > 0 ? ['authority'] : []),
        ...fmt.reasons,
        ...dur.reasons,
      ];
      const score =
        rel * 10 +
        auth * 5 +
        fmt.score * 3 +
        dur.score +
        prov +
        (c.snippet.length > 40 ? 1 : 0);
      return { ...c, score, rankReasons };
    })
    .sort((a, b) => b.score - a.score);
}
