import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { createWebOAuthState, googleAuthUrl, verifyWebOAuthState } from './integrations.js';

function oauthConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    DATABASE_URL: 'postgres://localhost/personal_os',
    PORT: 3000,
    HOST: '0.0.0.0',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DEVICE_AUTH_PEPPER: 'test-device-auth-pepper',
    WORKER_ENABLED: false,
    DEEPSEEK_MODEL: 'deepseek-chat',
    LLM_PROVIDER: 'fake',
    CALENDAR_PULL_INTERVAL_MS: 900_000,
    NOTIFY_MAX_PER_DAY: 8,
    PROACTIVE_SCAN_INTERVAL_MS: 2_700_000,
    USE_FAKE_PROVIDERS: false,
    GOOGLE_OAUTH_CLIENT_ID: 'web-client.apps.googleusercontent.com',
    GOOGLE_OAUTH_REDIRECT_URI:
      'https://soc-server-production.up.railway.app/v1/integrations/google/oauth-callback',
    ...overrides,
  };
}

describe('web Google OAuth state', () => {
  const secret = 'test-device-pepper-long-enough';

  it('accepts a fresh signed state', () => {
    const state = createWebOAuthState(secret, 1_000_000);
    expect(verifyWebOAuthState(state, secret, 1_005_000)).toBe(true);
  });

  it('rejects tampering and stale state', () => {
    const state = createWebOAuthState(secret, 1_000_000);
    expect(verifyWebOAuthState(`${state}x`, secret, 1_005_000)).toBe(false);
    expect(verifyWebOAuthState(state, secret, 1_700_001)).toBe(false);
  });
});

const EXPECTED_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars',
];

describe('Google OAuth URL', () => {
  it('always requests openid, email, events, calendarlist, and calendars manage', () => {
    const withCos = googleAuthUrl(oauthConfig({ GOOGLE_COS_CALENDAR_ID: 'planner@example.com' }), 'state');
    const url = new URL(withCos.url);

    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://soc-server-production.up.railway.app/v1/integrations/google/oauth-callback',
    );
    expect(withCos.scopes).toEqual(EXPECTED_SCOPES);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state');
  });

  it('requests offline access with explicit consent (refresh_token)', () => {
    const result = googleAuthUrl(oauthConfig(), 'state');
    const url = new URL(result.url);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBeNull();
  });
});

describe('googleScopesSatisfied', () => {
  it('accepts the required calendar scopes', async () => {
    const { googleScopesSatisfied } = await import('./integrations.js');
    expect(
      googleScopesSatisfied(
        [
          'openid',
          'email',
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
          'https://www.googleapis.com/auth/calendar.calendars',
        ].join(' '),
      ),
    ).toBe(true);
  });

  it('rejects missing calendars manage scope', async () => {
    const { googleScopesSatisfied } = await import('./integrations.js');
    expect(
      googleScopesSatisfied(
        'openid email https://www.googleapis.com/auth/calendar.events',
      ),
    ).toBe(false);
  });
});
