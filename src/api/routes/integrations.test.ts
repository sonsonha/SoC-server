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

describe('Google OAuth URL', () => {
  it('requests only event access when the Personal OS calendar ID is configured', () => {
    const result = googleAuthUrl(oauthConfig({ GOOGLE_COS_CALENDAR_ID: 'planner@example.com' }), 'state');
    const url = new URL(result.url);

    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://soc-server-production.up.railway.app/v1/integrations/google/oauth-callback',
    );
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.events',
    );
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('state')).toBe('state');
    expect(result.scopes).toEqual(['https://www.googleapis.com/auth/calendar.events']);
  });

  it('adds calendar discovery and creation scopes only when no calendar ID is configured', () => {
    const result = googleAuthUrl(oauthConfig());

    expect(result.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendars',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ]);
  });
});
