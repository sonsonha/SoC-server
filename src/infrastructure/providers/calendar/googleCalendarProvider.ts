import type { CalendarEvent, CalendarProvider } from './types.js';
import { FakeCalendarProvider } from './fakeCalendarProvider.js';

type TokenBundle = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
};

const COS_CALENDAR_NAME = 'Personal Chief of Staff';

/**
 * Google Calendar adapter.
 * COS writes go to GOOGLE_COS_CALENDAR_ID, or a calendar named "Personal Chief of Staff"
 * (created if missing). Failures are logged — not silently treated as success.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  private readonly fallback = new FakeCalendarProvider();
  private resolvedCosCalendarId: string | null = null;

  constructor(
    private readonly getTokens: () => Promise<TokenBundle | null>,
    private readonly refreshTokens: () => Promise<TokenBundle | null>,
    private readonly cosCalendarId?: string,
  ) {
    if (cosCalendarId) this.resolvedCosCalendarId = cosCalendarId;
  }

  private async bearer(): Promise<string | null> {
    let tokens = await this.getTokens();
    if (!tokens?.accessToken || tokens.accessToken === 'fake-access-token') return null;
    if (tokens.expiresAt && tokens.expiresAt.getTime() < Date.now() + 60_000) {
      tokens = (await this.refreshTokens()) ?? tokens;
    }
    if (!tokens?.accessToken || tokens.accessToken === 'fake-access-token') return null;
    return tokens.accessToken;
  }

  async listEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]> {
    try {
      const accessToken = await this.bearer();
      if (!accessToken) return this.fallback.listEvents(fromEpochMs, toEpochMs);
      const timeMin = new Date(fromEpochMs).toISOString();
      const timeMax = new Date(toEpochMs).toISOString();
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      url.searchParams.set('timeMin', timeMin);
      url.searchParams.set('timeMax', timeMax);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        console.error('google.listEvents failed', res.status, await res.text());
        return this.fallback.listEvents(fromEpochMs, toEpochMs);
      }
      const data = (await res.json()) as {
        items?: Array<{
          id?: string;
          summary?: string;
          location?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
        }>;
      };
      return (data.items ?? []).flatMap((item) => {
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
    } catch (err) {
      console.error('google.listEvents error', err);
      return this.fallback.listEvents(fromEpochMs, toEpochMs);
    }
  }

  /** Resolve or create the dedicated CoS write calendar. */
  private async ensureCosCalendarId(accessToken: string): Promise<string> {
    if (this.resolvedCosCalendarId) return this.resolvedCosCalendarId;

    const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (listRes.ok) {
      const data = (await listRes.json()) as {
        items?: Array<{ id?: string; summary?: string }>;
      };
      const match = (data.items ?? []).find(
        (c) => c.summary?.toLowerCase() === COS_CALENDAR_NAME.toLowerCase(),
      );
      if (match?.id) {
        this.resolvedCosCalendarId = match.id;
        console.log('google.cosCalendar resolved', match.id);
        return match.id;
      }
    } else {
      console.error('google.calendarList failed', listRes.status, await listRes.text());
    }

    const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ summary: COS_CALENDAR_NAME, timeZone: 'Asia/Ho_Chi_Minh' }),
    });
    if (!createRes.ok) {
      const detail = await createRes.text();
      throw new Error(`Could not create CoS calendar: ${createRes.status} ${detail}`);
    }
    const created = (await createRes.json()) as { id?: string };
    if (!created.id) throw new Error('Google created calendar without id');
    this.resolvedCosCalendarId = created.id;
    console.log('google.cosCalendar created', created.id);
    return created.id;
  }

  async upsertCosEvent(
    event: Omit<CalendarEvent, 'eventId'> & { eventId?: string },
  ): Promise<string> {
    const accessToken = await this.bearer();
    if (!accessToken) {
      console.error(
        'google.upsertCosEvent: no real OAuth token (fake connect or not connected) — not writing to Google',
      );
      return this.fallback.upsertCosEvent!(event);
    }

    try {
      const calendarId = await this.ensureCosCalendarId(accessToken);
      const body = {
        summary: event.title,
        start: { dateTime: new Date(event.startEpochMs).toISOString() },
        end: { dateTime: new Date(event.endEpochMs).toISOString() },
        location: event.location ?? undefined,
      };
      const existingId = event.eventId?.startsWith('cos-') ? undefined : event.eventId;
      const url = existingId
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existingId)}`
        : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      const res = await fetch(url, {
        method: existingId ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text();
        console.error('google.upsertCosEvent failed', res.status, detail);
        throw new Error(`Google Calendar write failed: ${res.status} ${detail}`);
      }
      const data = (await res.json()) as { id?: string };
      const id = data.id ?? existingId ?? `cos-${event.startEpochMs}`;
      console.log('google.upsertCosEvent ok', { id, title: event.title });
      return id;
    } catch (err) {
      console.error('google.upsertCosEvent error', err);
      throw err;
    }
  }

  async deleteCosEvent(eventId: string): Promise<void> {
    if (eventId.startsWith('cos-')) {
      await this.fallback.deleteCosEvent!(eventId);
      return;
    }
    const accessToken = await this.bearer();
    if (!accessToken) {
      await this.fallback.deleteCosEvent!(eventId);
      return;
    }
    try {
      const calendarId = await this.ensureCosCalendarId(accessToken);
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok && res.status !== 204 && res.status !== 404) {
        console.error('google.deleteCosEvent failed', res.status, await res.text());
      }
    } catch (err) {
      console.error('google.deleteCosEvent error', err);
    }
  }
}
