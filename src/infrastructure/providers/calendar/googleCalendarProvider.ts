import type { CalendarEvent, CalendarProvider } from './types.js';
import { FakeCalendarProvider } from './fakeCalendarProvider.js';

type TokenBundle = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
};

const COS_CALENDAR_NAME = 'Personal Planner';

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

  private async fetchEvents(
    accessToken: string,
    calendarId: string,
    fromEpochMs: number,
    toEpochMs: number,
  ): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      );
      url.searchParams.set('timeMin', new Date(fromEpochMs).toISOString());
      url.searchParams.set('timeMax', new Date(toEpochMs).toISOString());
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '2500');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Google Calendar read failed: ${res.status} ${detail}`);
      }
      const data = (await res.json()) as {
        nextPageToken?: string;
        items?: Array<{
          id?: string;
          summary?: string;
          location?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          extendedProperties?: { private?: Record<string, string> };
        }>;
      };
      for (const item of data.items ?? []) {
        const startIso = item.start?.dateTime ?? item.start?.date;
        const endIso = item.end?.dateTime ?? item.end?.date;
        if (!item.id || !startIso || !endIso) continue;
        const startEpochMs = new Date(startIso).getTime();
        const endEpochMs = new Date(endIso).getTime();
        if (Number.isNaN(startEpochMs) || Number.isNaN(endEpochMs)) continue;
        events.push({
          eventId: item.id,
          title: item.summary ?? 'Busy',
          startEpochMs,
          endEpochMs,
          location: item.location ?? null,
          calendarId,
          appMetadata: item.extendedProperties?.private,
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return events;
  }

  async listEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]> {
    const accessToken = await this.bearer();
    if (!accessToken) return this.fallback.listEvents(fromEpochMs, toEpochMs);
    return this.fetchEvents(accessToken, 'primary', fromEpochMs, toEpochMs);
  }

  async listCosEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]> {
    const accessToken = await this.bearer();
    if (!accessToken) return [];
    const calendarId = await this.ensureCosCalendarId(accessToken);
    return this.fetchEvents(accessToken, calendarId, fromEpochMs, toEpochMs);
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
      throw new Error('Google Calendar is not connected');
    }

    try {
      const calendarId = await this.ensureCosCalendarId(accessToken);
      const body = {
        summary: event.title,
        start: { dateTime: new Date(event.startEpochMs).toISOString() },
        end: { dateTime: new Date(event.endEpochMs).toISOString() },
        location: event.location ?? undefined,
        extendedProperties: event.appMetadata
          ? { private: event.appMetadata }
          : undefined,
      };
      const existingId = event.eventId?.startsWith('cos-') ? undefined : event.eventId;
      const createUrl =
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      const url = existingId
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existingId)}`
        : createUrl;
      let res = await fetch(url, {
        method: existingId ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      // A user may delete an app-owned event directly in Google. If they then
      // move the still-local block before pulling, recreate it instead of
      // leaving the block permanently FAILED.
      if (existingId && (res.status === 404 || res.status === 410)) {
        res = await fetch(createUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      }
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
