import { describe, expect, it, vi } from 'vitest';
import { createUserCalendarProviderAsync } from './userCalendarProvider.js';
import type { AppConfig } from '../../config.js';

vi.mock('../../infrastructure/providers/calendar/googleCalendarProvider.js', () => ({
  parseConfiguredReadCalendarIds: () => [],
  GoogleCalendarProvider: class {
    options: { writeCalendarId?: string | null };
    constructor(
      _get: unknown,
      _refresh: unknown,
      options: { writeCalendarId?: string | null },
    ) {
      this.options = options;
    }
  },
}));

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    GOOGLE_OAUTH_CLIENT_ID: 'calendar-client.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    GOOGLE_COS_CALENDAR_ID: 'legacy-owner-cos-id',
    ...overrides,
  } as AppConfig;
}

describe('createUserCalendarProviderAsync write calendar fallback', () => {
  it('never injects GOOGLE_COS_CALENDAR_ID for second users', async () => {
    const tokenService = {
      getGoogleCalendarTokens: vi.fn(async () => ({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: new Date(),
        writeCalendarId: null,
      })),
      setWriteCalendarId: vi.fn(),
      refreshGoogleAccessToken: vi.fn(),
    };
    const provider = await createUserCalendarProviderAsync({
      userId: 'user-b',
      tokenService: tokenService as never,
      config: baseConfig(),
      allowLegacyCosCalendarFallback: false,
    });
    expect((provider as { options: { writeCalendarId: string | null } }).options.writeCalendarId).toBeNull();
  });

  it('allows GOOGLE_COS_CALENDAR_ID only for initial owner opt-in', async () => {
    const tokenService = {
      getGoogleCalendarTokens: vi.fn(async () => ({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: new Date(),
        writeCalendarId: null,
      })),
      setWriteCalendarId: vi.fn(),
      refreshGoogleAccessToken: vi.fn(),
    };
    const provider = await createUserCalendarProviderAsync({
      userId: 'user-owner',
      tokenService: tokenService as never,
      config: baseConfig(),
      allowLegacyCosCalendarFallback: true,
    });
    expect((provider as { options: { writeCalendarId: string | null } }).options.writeCalendarId)
      .toBe('legacy-owner-cos-id');
  });

  it('prefers stored writeCalendarId over legacy COS id', async () => {
    const tokenService = {
      getGoogleCalendarTokens: vi.fn(async () => ({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: new Date(),
        writeCalendarId: 'user-b-personal-os',
      })),
      setWriteCalendarId: vi.fn(),
      refreshGoogleAccessToken: vi.fn(),
    };
    const provider = await createUserCalendarProviderAsync({
      userId: 'user-b',
      tokenService: tokenService as never,
      config: baseConfig(),
      allowLegacyCosCalendarFallback: false,
    });
    expect((provider as { options: { writeCalendarId: string | null } }).options.writeCalendarId)
      .toBe('user-b-personal-os');
  });
});
