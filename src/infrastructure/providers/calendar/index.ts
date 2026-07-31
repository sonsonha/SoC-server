import type { AppConfig } from '../../../config.js';
import type { CalendarProvider } from './types.js';
import { FakeCalendarProvider } from './fakeCalendarProvider.js';
import { GoogleCalendarProvider } from './googleCalendarProvider.js';

export type CalendarTokenAccessor = {
  getTokens: () => Promise<{
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
  } | null>;
  refreshTokens: () => Promise<{
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
  } | null>;
};

export function createCalendarProvider(
  config: AppConfig,
  tokens?: CalendarTokenAccessor,
): CalendarProvider {
  if (config.USE_FAKE_PROVIDERS || !tokens) {
    return new FakeCalendarProvider();
  }
  if (!config.GOOGLE_OAUTH_CLIENT_ID) {
    return new FakeCalendarProvider();
  }
  return new GoogleCalendarProvider(
    tokens.getTokens,
    tokens.refreshTokens,
    config.GOOGLE_COS_CALENDAR_ID,
  );
}

export type { CalendarEvent, CalendarProvider } from './types.js';
export { FakeCalendarProvider } from './fakeCalendarProvider.js';
export { GoogleCalendarProvider } from './googleCalendarProvider.js';
