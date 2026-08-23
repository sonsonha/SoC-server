import { createHash } from 'node:crypto';
import { verifyGoogleIdToken } from '../identity/googleIdToken.js';

/** Safe fingerprint for logs — never log full Google sub. */
export function googleSubFingerprint(sub: string | null | undefined): {
  present: boolean;
  last6: string | null;
  sha256_8: string | null;
} {
  if (!sub) return { present: false, last6: null, sha256_8: null };
  return {
    present: true,
    last6: sub.slice(-6),
    sha256_8: createHash('sha256').update(sub).digest('hex').slice(0, 8),
  };
}

/**
 * Account-match gate: Calendar OAuth Google sub must equal Personal OS login sub.
 * Never compare OAuth client ids (aud/azp) or fall back to email-only matching.
 */
export function assertSameGoogleAccount(opts: {
  personalOsSub: string;
  calendarSub: string | null | undefined;
}): { ok: true } | { ok: false; code: 'GOOGLE_ACCOUNT_MISMATCH' } {
  if (!opts.calendarSub || opts.calendarSub !== opts.personalOsSub) {
    return { ok: false, code: 'GOOGLE_ACCOUNT_MISMATCH' };
  }
  return { ok: true };
}

/**
 * Fetch Google account identity from a Calendar OAuth access token.
 * Prefer official OIDC userinfo; accept legacy `id` as sub alias.
 */
export async function fetchGoogleAccountIdentity(accessToken: string): Promise<{
  sub: string;
  email: string;
} | null> {
  const endpoints = [
    'https://openidconnect.googleapis.com/v1/userinfo',
    'https://www.googleapis.com/oauth2/v3/userinfo',
  ] as const;

  for (const url of endpoints) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error('google.userinfo failed', { googleStatus: res.status, endpoint: url });
      continue;
    }
    const body = (await res.json()) as {
      sub?: string;
      id?: string;
      email?: string;
    };
    const sub = (body.sub ?? body.id)?.trim() || '';
    const email = body.email?.trim() || '';
    if (sub && email) return { sub, email };
  }
  return null;
}

/**
 * Resolve the Calendar-authorized Google user.
 * Prefer verifying the OAuth `id_token` (aud = Calendar client) — same Google `sub`
 * as GIS login even when identity and Calendar use different OAuth clients.
 */
export async function resolveCalendarGoogleIdentity(opts: {
  accessToken: string;
  idToken?: string | null;
  /** Must be GOOGLE_OAUTH_CLIENT_ID — never GOOGLE_IDENTITY_CLIENT_ID. */
  calendarOAuthClientId: string;
}): Promise<{ sub: string; email: string; source: 'id_token' | 'userinfo' } | null> {
  const clientId = opts.calendarOAuthClientId.trim();
  if (opts.idToken?.trim() && clientId) {
    try {
      const identity = await verifyGoogleIdToken(opts.idToken.trim(), clientId);
      return { sub: identity.sub, email: identity.email, source: 'id_token' };
    } catch {
      // Fall through to userinfo — do not treat verify failure as account mismatch.
    }
  }
  const fromUserinfo = await fetchGoogleAccountIdentity(opts.accessToken);
  if (!fromUserinfo) return null;
  return { ...fromUserinfo, source: 'userinfo' };
}
