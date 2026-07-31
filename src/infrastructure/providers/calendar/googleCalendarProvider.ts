import type { CalendarEvent, CalendarProvider } from './types.js';
import { FakeCalendarProvider } from './fakeCalendarProvider.js';

type TokenBundle = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
};

/**
 * Google Calendar read adapter. Falls back to FakeCalendarProvider on API failure.
 * Write path (stretch) only targets a dedicated COS calendar id — never primary EXTERNAL events.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  private readonly fallback = new FakeCalendarProvider();

  constructor(
    private readonly getTokens: () => Promise<TokenBundle | null>,
    private readonly refreshTokens: () => Promise<TokenBundle | null>,
    private readonly cosCalendarId?: string,
  ) {}

  async listEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]> {
    try {
      let tokens = await this.getTokens();
      if (!tokens?.accessToken) return this.fallback.listEvents(fromEpochMs, toEpochMs);
      if (tokens.expiresAt && tokens.expiresAt.getTime() < Date.now() + 60_000) {
        tokens = (await this.refreshTokens()) ?? tokens;
      }
      const timeMin = new Date(fromEpochMs).toISOString();
      const timeMax = new Date(toEpochMs).toISOString();
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      url.searchParams.set('timeMin', timeMin);
      url.searchParams.set('timeMax', timeMax);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (!res.ok) return this.fallback.listEvents(fromEpochMs, toEpochMs);
      const data = (await res.json()) as {
        items?: Array<{
          id?: string;
          summary?: string;
          location?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
        }>;
      };
      return (data.items ?? [])
        .flatMap((item) => {
          const startIso = item.start?.dateTime ?? item.start?.date;
          const endIso = item.end?.dateTime ?? item.end?.date;
          if (!item.id || !startIso || !endIso) return [];
          const startEpochMs = new Date(startIso).getTime();
          const endEpochMs = new Date(endIso).getTime();
          if (Number.isNaN(startEpochMs) || Number.isNaN(endEpochMs)) return [];
          const event: CalendarEvent = {
            eventId: item.id,
            title: item.summary ?? 'Busy',
            startEpochMs,
            endEpochMs,
            location: item.location ?? null,
            calendarId: 'primary',
          };
          return [event];
        });
    } catch {
      return this.fallback.listEvents(fromEpochMs, toEpochMs);
    }
  }

  async upsertCosEvent(
    event: Omit<CalendarEvent, 'eventId'> & { eventId?: string },
  ): Promise<string> {
    const calendarId = this.cosCalendarId;
    if (!calendarId) {
      return this.fallback.upsertCosEvent!(event);
    }
    try {
      let tokens = await this.getTokens();
      if (!tokens?.accessToken) return this.fallback.upsertCosEvent!(event);
      if (tokens.expiresAt && tokens.expiresAt.getTime() < Date.now() + 60_000) {
        tokens = (await this.refreshTokens()) ?? tokens;
      }
      const body = {
        summary: event.title,
        start: { dateTime: new Date(event.startEpochMs).toISOString() },
        end: { dateTime: new Date(event.endEpochMs).toISOString() },
        location: event.location ?? undefined,
      };
      const existingId = event.eventId;
      const url = existingId
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existingId)}`
        : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      const res = await fetch(url, {
        method: existingId ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) return this.fallback.upsertCosEvent!(event);
      const data = (await res.json()) as { id?: string };
      return data.id ?? existingId ?? `cos-${event.startEpochMs}`;
    } catch {
      return this.fallback.upsertCosEvent!(event);
    }
  }

  async deleteCosEvent(eventId: string): Promise<void> {
    const calendarId = this.cosCalendarId;
    if (!calendarId) {
      await this.fallback.deleteCosEvent!(eventId);
      return;
    }
    try {
      let tokens = await this.getTokens();
      if (!tokens?.accessToken) {
        await this.fallback.deleteCosEvent!(eventId);
        return;
      }
      if (tokens.expiresAt && tokens.expiresAt.getTime() < Date.now() + 60_000) {
        tokens = (await this.refreshTokens()) ?? tokens;
      }
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (!res.ok && res.status !== 404) {
        await this.fallback.deleteCosEvent!(eventId);
      }
    } catch {
      await this.fallback.deleteCosEvent!(eventId);
    }
  }
}
