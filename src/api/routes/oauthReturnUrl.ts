import type { AppConfig } from '../../config.js';

const LEGACY_CHATGPT_HOST_MARKER = 'chatgpt.site';

/**
 * Canonical Personal OS web origin for post-OAuth redirects.
 * Never derived from request Origin/Referer — only from PLANNER_WEB_RETURN_URL
 * (or localhost in non-production when unset).
 */
export function resolvePlannerWebReturnUrl(config: AppConfig): string {
  const configured = config.PLANNER_WEB_RETURN_URL?.trim();
  if (configured) {
    let origin: string;
    try {
      origin = new URL(configured).origin;
    } catch {
      throw new Error('PLANNER_WEB_RETURN_URL is not a valid URL');
    }
    if (origin.includes(LEGACY_CHATGPT_HOST_MARKER)) {
      throw new Error(
        'PLANNER_WEB_RETURN_URL points at legacy chatgpt.site — set your Vercel origin (e.g. https://personal-planner-web-ivory.vercel.app)',
      );
    }
    return origin;
  }
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'PLANNER_WEB_RETURN_URL is required in production (set to your Vercel frontend origin)',
    );
  }
  return 'http://localhost:3000';
}

/** Success landing after Google consent — always the Calendar route. */
export function oauthSuccessRedirectUrl(config: AppConfig): string {
  return `${resolvePlannerWebReturnUrl(config)}/calendar?google=connected`;
}

/** Failure landing — safe reason query only (no tokens). */
export function oauthErrorRedirectUrl(config: AppConfig, reason?: string): string {
  const url = new URL(`${resolvePlannerWebReturnUrl(config)}/calendar`);
  url.searchParams.set('google', 'error');
  if (reason) {
    url.searchParams.set('reason', reason.replace(/[^\w.-]+/g, '_').slice(0, 80));
  }
  return url.toString();
}

/** Reject open redirects: only the configured origin (or localhost in non-prod). */
export function isAllowedPlannerWebReturnUrl(candidate: string, config: AppConfig): boolean {
  try {
    const allowed = resolvePlannerWebReturnUrl(config);
    const got = new URL(candidate).origin;
    return got === allowed;
  } catch {
    return false;
  }
}
