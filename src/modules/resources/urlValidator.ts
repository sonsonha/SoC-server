import type { SearchCandidate } from '../../infrastructure/providers/search/types.js';

export type UrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

/**
 * Reject URLs that were not returned by the search provider (anti-hallucination).
 */
export function validateCandidateUrl(
  candidateUrl: string,
  searchResults: SearchCandidate[],
): UrlValidationResult {
  if (!candidateUrl || !candidateUrl.startsWith('http')) {
    return { ok: false, reason: 'URL must be an absolute http(s) URL' };
  }

  const normalized = normalizeUrl(candidateUrl);
  const allowed = new Set(searchResults.map((r) => normalizeUrl(r.url)));

  if (!allowed.has(normalized)) {
    return {
      ok: false,
      reason: 'URL was not present in search results',
    };
  }

  return { ok: true, url: normalized };
}
