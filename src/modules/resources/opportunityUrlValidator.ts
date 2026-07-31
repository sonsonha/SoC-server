import type { SearchCandidate } from '../../infrastructure/providers/search/types.js';
import { validateCandidateUrl, type UrlValidationResult } from './urlValidator.js';

const OFFICIAL_TLD = /\.(gov|edu)(\.[a-z]{2})?(\/|$)/i;

export function isOfficialSourceUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_TLD.test(host);
  } catch {
    return false;
  }
}

export function validateOpportunityPrimaryUrl(
  candidateUrl: string,
  searchResults: SearchCandidate[],
): UrlValidationResult {
  const base = validateCandidateUrl(candidateUrl, searchResults);
  if (!base.ok) return base;

  const hasOfficial = searchResults.some((r) => isOfficialSourceUrl(r.url));
  if (hasOfficial && !isOfficialSourceUrl(base.url)) {
    return {
      ok: false,
      reason: 'Opportunity prep requires an official (.gov/.edu) primary source',
    };
  }

  return base;
}
