/**
 * Account-match gate tests + Terry-shaped Calendar identity fixture.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assertSameGoogleAccount,
  fetchGoogleAccountIdentity,
  googleSubFingerprint,
  resolveCalendarGoogleIdentity,
} from './googleAccountIdentity.js';

describe('Google account match for Calendar connect', () => {
  it('accepts matching subs (User B / Terry same account)', () => {
    const subB = 'SUB_B_terry_google_subject';
    expect(
      assertSameGoogleAccount({
        personalOsSub: subB,
        calendarSub: subB,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects mismatched Calendar sub (GOOGLE_ACCOUNT_MISMATCH)', () => {
    expect(
      assertSameGoogleAccount({
        personalOsSub: 'SUB_B',
        calendarSub: 'SUB_C',
      }),
    ).toEqual({
      ok: false,
      code: 'GOOGLE_ACCOUNT_MISMATCH',
    });
    expect(
      assertSameGoogleAccount({
        personalOsSub: 'SUB_B',
        calendarSub: null,
      }),
    ).toEqual({
      ok: false,
      code: 'GOOGLE_ACCOUNT_MISMATCH',
    });
  });

  it('does not treat equal emails as a substitute for sub (policy)', () => {
    const match = assertSameGoogleAccount({
      personalOsSub: 'SUB_B',
      calendarSub: 'SUB_C',
    });
    expect(match.ok).toBe(false);
  });

  it('fingerprints never expose full sub', () => {
    const fp = googleSubFingerprint('abcdefghijklmnopqrstuvwxyz012345');
    expect(fp.present).toBe(true);
    expect(fp.last6).toBe('012345');
    expect(fp.sha256_8).toMatch(/^[a-f0-9]{8}$/);
    expect(JSON.stringify(fp)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('resolveCalendarGoogleIdentity', () => {
  it('falls back to userinfo and accepts sub', async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes('userinfo')) {
        return new Response(
          JSON.stringify({
            sub: 'SUB_B',
            email: 'terryson821@gmail.com',
          }),
          { status: 200 },
        );
      }
      return new Response('no', { status: 404 });
    }) as typeof fetch;

    const identity = await resolveCalendarGoogleIdentity({
      accessToken: 'access',
      idToken: null,
      calendarOAuthClientId: 'calendar-client.apps.googleusercontent.com',
    });
    expect(identity).toEqual({
      sub: 'SUB_B',
      email: 'terryson821@gmail.com',
      source: 'userinfo',
    });
  });

  it('returns null when identity cannot be resolved (not a mismatch)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('unauthorized', { status: 401 }),
    ) as typeof fetch;
    const identity = await resolveCalendarGoogleIdentity({
      accessToken: 'access',
      idToken: null,
      calendarOAuthClientId: 'calendar-client.apps.googleusercontent.com',
    });
    expect(identity).toBeNull();
  });
});

describe('fetchGoogleAccountIdentity', () => {
  it('accepts legacy id field as sub alias', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 'SUB_FROM_ID', email: 'terryson821@gmail.com' }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const identity = await fetchGoogleAccountIdentity('access');
    expect(identity).toEqual({
      sub: 'SUB_FROM_ID',
      email: 'terryson821@gmail.com',
    });
  });
});
