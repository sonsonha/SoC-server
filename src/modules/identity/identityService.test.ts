import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionCookie,
  clearSessionCookie,
  isEmailAllowlisted,
  parseAllowedEmails,
  readSessionTokenFromCookieHeader,
  SESSION_COOKIE_NAME,
} from './identityService.js';
import { hashSessionToken } from './googleIdToken.js';

describe('allowlist', () => {
  it('denies everyone when allowlist is empty', () => {
    expect(isEmailAllowlisted('owner@example.com', parseAllowedEmails(undefined))).toBe(false);
    expect(isEmailAllowlisted('owner@example.com', parseAllowedEmails(''))).toBe(false);
  });

  it('matches emails case-insensitively', () => {
    const allowed = parseAllowedEmails('Owner@Example.com, other@x.com');
    expect(isEmailAllowlisted('owner@example.com', allowed)).toBe(true);
    expect(isEmailAllowlisted('stranger@example.com', allowed)).toBe(false);
  });
});

describe('session cookie helpers', () => {
  it('builds HttpOnly SameSite=Lax cookies and clears them', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const cookie = buildSessionCookie('raw-token-value', expiresAt, { secure: true });
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=raw-token-value`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(clearSessionCookie({ secure: true })).toContain('Max-Age=0');
  });

  it('reads the opaque token from Cookie headers', () => {
    expect(readSessionTokenFromCookieHeader('a=1; pos_session=abc123; b=2')).toBe('abc123');
    expect(readSessionTokenFromCookieHeader(undefined)).toBeNull();
  });

  it('hashes session tokens (never store raw)', () => {
    const a = hashSessionToken('same');
    const b = hashSessionToken('same');
    const c = hashSessionToken('other');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('Google ID token verification seams', () => {
  it('rejects wrong audience / expired tokens via verifyGoogleIdToken', async () => {
    vi.resetModules();
    vi.doMock('jose', () => ({
      createRemoteJWKSet: () => ({}),
      jwtVerify: async () => {
        throw new Error('bad token');
      },
    }));
    const { verifyGoogleIdToken } = await import('./googleIdToken.js');
    await expect(verifyGoogleIdToken('x'.repeat(40), 'audience')).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
      statusCode: 401,
    });
    vi.doUnmock('jose');
  });
});
