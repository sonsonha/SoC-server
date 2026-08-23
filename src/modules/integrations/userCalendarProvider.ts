import type { AppConfig } from '../../config.js';
import type { CalendarProvider } from '../../infrastructure/providers/calendar/types.js';
import { FakeCalendarProvider } from '../../infrastructure/providers/calendar/fakeCalendarProvider.js';
import {
  GoogleCalendarProvider,
  parseConfiguredReadCalendarIds,
} from '../../infrastructure/providers/calendar/googleCalendarProvider.js';
import type { IntegrationTokenService } from './tokenService.js';

/**
 * Build a CalendarProvider scoped to one Personal OS user.
 * Tokens, write calendar, and refresh are always user-bound.
 */
export function createUserCalendarProvider(deps: {
  userId: string;
  tokenService: IntegrationTokenService;
  config: AppConfig;
  /** Shared fake for tests / USE_FAKE_PROVIDERS */
  fake?: FakeCalendarProvider;
}): CalendarProvider {
  const { userId, tokenService, config, fake } = deps;
  if (config.USE_FAKE_PROVIDERS || !config.GOOGLE_OAUTH_CLIENT_ID) {
    return fake ?? new FakeCalendarProvider();
  }

  // Legacy env write calendar only as initial fallback when row has no writeCalendarId yet
  // (owner migration). New users resolve/create their own Personal OS calendar.
  const legacyWriteFallback = config.GOOGLE_COS_CALENDAR_ID;

  return new GoogleCalendarProvider(
    async () => {
      const t = await tokenService.getGoogleCalendarTokens(userId);
      if (!t) return null;
      return {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
      };
    },
    async () => {
      const t = await tokenService.refreshGoogleAccessToken(userId, {
        clientId: config.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
      });
      if (!t) return null;
      return {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
      };
    },
    {
      writeCalendarId: undefined, // loaded async below via first call path
      extraReadCalendarIds: parseConfiguredReadCalendarIds(config.GOOGLE_READ_CALENDAR_IDS),
      onWriteCalendarResolved: async (calendarId) => {
        await tokenService.setWriteCalendarId(userId, calendarId);
      },
    },
  );
}

/** Load write calendar from DB into provider options (fresh instance per sync). */
export async function createUserCalendarProviderAsync(deps: {
  userId: string;
  tokenService: IntegrationTokenService;
  config: AppConfig;
  fake?: FakeCalendarProvider;
}): Promise<CalendarProvider> {
  const { userId, tokenService, config, fake } = deps;
  if (config.USE_FAKE_PROVIDERS || !config.GOOGLE_OAUTH_CLIENT_ID) {
    return fake ?? new FakeCalendarProvider();
  }
  const stored = await tokenService.getGoogleCalendarTokens(userId);
  const writeCalendarId = stored?.writeCalendarId ?? config.GOOGLE_COS_CALENDAR_ID ?? null;
  return new GoogleCalendarProvider(
    async () => {
      const t = await tokenService.getGoogleCalendarTokens(userId);
      if (!t) return null;
      return {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
      };
    },
    async () => {
      const t = await tokenService.refreshGoogleAccessToken(userId, {
        clientId: config.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
      });
      if (!t) return null;
      return {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
      };
    },
    {
      writeCalendarId,
      extraReadCalendarIds: parseConfiguredReadCalendarIds(config.GOOGLE_READ_CALENDAR_IDS),
      onWriteCalendarResolved: async (calendarId) => {
        await tokenService.setWriteCalendarId(userId, calendarId);
      },
    },
  );
}
