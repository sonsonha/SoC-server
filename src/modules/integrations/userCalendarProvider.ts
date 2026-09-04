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
 *
 * Never inject GOOGLE_COS_CALENDAR_ID here — that legacy env calendar is owner-only
 * and must be opted in via createUserCalendarProviderAsync({ allowLegacyCosCalendarFallback }).
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
      writeCalendarId: undefined,
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
  /**
   * ONLY for PERSONAL_OS_INITIAL_OWNER_EMAIL.
   * Second users must find/create their own Personal OS Google calendar.
   */
  allowLegacyCosCalendarFallback?: boolean;
}): Promise<CalendarProvider> {
  const { userId, tokenService, config, fake } = deps;
  if (config.USE_FAKE_PROVIDERS || !config.GOOGLE_OAUTH_CLIENT_ID) {
    return fake ?? new FakeCalendarProvider();
  }
  const stored = await tokenService.getGoogleCalendarTokens(userId);
  const legacyRaw = deps.allowLegacyCosCalendarFallback
    ? (config.GOOGLE_COS_CALENDAR_ID ?? null)
    : null;
  // Never treat Google's primary calendar (often shown as the user's name) as the write target.
  const legacyFallback = legacyRaw && legacyRaw !== 'primary' ? legacyRaw : null;
  const storedWrite = stored?.writeCalendarId && stored.writeCalendarId !== 'primary'
    ? stored.writeCalendarId
    : null;
  const writeCalendarId = storedWrite ?? legacyFallback;
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
