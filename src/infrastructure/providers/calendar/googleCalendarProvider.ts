import type { CalendarEvent, CalendarProvider } from './types.js';
import { FakeCalendarProvider } from './fakeCalendarProvider.js';
import {
  GoogleCalendarError,
  googleErrorFromHttp,
  parseGoogleErrorBody,
} from './googleErrors.js';

type TokenBundle = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
};

const COS_CALENDAR_NAMES = ['Personal Planner', 'Personal Chief of Staff'] as const;
const PLANNER_TZ = 'Asia/Ho_Chi_Minh';

/**
 * Google Calendar adapter.
 * COS writes go to GOOGLE_COS_CALENDAR_ID, or a calendar named "Personal Planner"
 * (also matches legacy "Personal Chief of Staff"; created if missing).
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

  private async bearer(operation: string): Promise<string> {
    let tokens = await this.getTokens();
    if (!tokens?.accessToken || tokens.accessToken === 'fake-access-token') {
      throw new GoogleCalendarError('Google Calendar is not connected', 'GOOGLE_NOT_CONNECTED', {
        statusCode: 401,
        operation,
      });
    }
    if (tokens.expiresAt && tokens.expiresAt.getTime() < Date.now() + 60_000) {
      const refreshed = await this.refreshTokens();
      if (!refreshed?.accessToken || refreshed.accessToken === tokens.accessToken) {
        // Refresh failed or returned the same expired token.
        if (tokens.expiresAt.getTime() < Date.now()) {
          throw new GoogleCalendarError(
            'Google Calendar access expired — reconnect required',
            'GOOGLE_RECONNECT_REQUIRED',
            { statusCode: 401, reason: 'token_refresh_failed', operation },
          );
        }
      } else {
        tokens = refreshed;
      }
    }
    if (!tokens?.accessToken || tokens.accessToken === 'fake-access-token') {
      throw new GoogleCalendarError(
        'Google Calendar access expired — reconnect required',
        'GOOGLE_RECONNECT_REQUIRED',
        { statusCode: 401, operation },
      );
    }
    return tokens.accessToken;
  }

  private async fetchEvents(
    accessToken: string,
    calendarId: string,
    fromEpochMs: number,
    toEpochMs: number,
    operation: string,
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
        throw googleErrorFromHttp({
          operation,
          googleStatus: res.status,
          detail,
        });
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
    try {
      const accessToken = await this.bearer('listEvents');
      return await this.fetchEvents(accessToken, 'primary', fromEpochMs, toEpochMs, 'listEvents');
    } catch (err) {
      if (err instanceof GoogleCalendarError && err.code === 'GOOGLE_NOT_CONNECTED') {
        return this.fallback.listEvents(fromEpochMs, toEpochMs);
      }
      throw err;
    }
  }

  async listCosEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]> {
    const accessToken = await this.bearer('listCosEvents');
    const calendarId = await this.ensureCosCalendarId(accessToken);
    return this.fetchEvents(accessToken, calendarId, fromEpochMs, toEpochMs, 'listCosEvents');
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
      const names = new Set(COS_CALENDAR_NAMES.map((n) => n.toLowerCase()));
      const match = (data.items ?? []).find((c) => c.summary && names.has(c.summary.toLowerCase()));
      if (match?.id) {
        this.resolvedCosCalendarId = match.id;
        console.info('google.cosCalendar resolved', { calendarId: match.id, summary: match.summary });
        return match.id;
      }
    } else {
      const detail = await listRes.text();
      console.error('google.calendarList failed', {
        googleStatus: listRes.status,
        ...parseGoogleErrorBody(detail),
      });
      // Fall through to create — may also fail if scopes are insufficient.
      if (listRes.status === 401 || listRes.status === 403) {
        throw googleErrorFromHttp({
          operation: 'ensureCosCalendarId.list',
          googleStatus: listRes.status,
          detail,
        });
      }
    }

    const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ summary: COS_CALENDAR_NAMES[0], timeZone: PLANNER_TZ }),
    });
    if (!createRes.ok) {
      const detail = await createRes.text();
      console.error('google.cosCalendar create failed', {
        googleStatus: createRes.status,
        ...parseGoogleErrorBody(detail),
      });
      throw googleErrorFromHttp({
        operation: 'ensureCosCalendarId.create',
        googleStatus: createRes.status,
        detail,
      });
    }
    const created = (await createRes.json()) as { id?: string };
    if (!created.id) {
      throw new GoogleCalendarError(
        'Google created calendar without id',
        'GOOGLE_UNKNOWN',
        { statusCode: 502, operation: 'ensureCosCalendarId.create' },
      );
    }
    this.resolvedCosCalendarId = created.id;
    console.info('google.cosCalendar created', { calendarId: created.id });
    return created.id;
  }

  private eventBody(event: Omit<CalendarEvent, 'eventId'> & { eventId?: string }) {
    return {
      summary: event.title,
      start: {
        dateTime: new Date(event.startEpochMs).toISOString(),
        timeZone: PLANNER_TZ,
      },
      end: {
        dateTime: new Date(event.endEpochMs).toISOString(),
        timeZone: PLANNER_TZ,
      },
      location: event.location ?? undefined,
      extendedProperties: event.appMetadata
        ? { private: event.appMetadata }
        : undefined,
    };
  }

  async upsertCosEvent(
    event: Omit<CalendarEvent, 'eventId'> & { eventId?: string },
  ): Promise<string> {
    const accessToken = await this.bearer('upsertCosEvent');
    const timeBlockId = event.appMetadata?.timeBlockId;
    const hasGoogleEventId = Boolean(event.eventId && !event.eventId.startsWith('cos-'));

    try {
      const calendarId = await this.ensureCosCalendarId(accessToken);
      const body = this.eventBody(event);
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
        console.info('google.upsertCosEvent stale id — recreating', {
          timeBlockId: timeBlockId ?? null,
          hasGoogleEventId: true,
          googleStatus: res.status,
        });
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
        const err = googleErrorFromHttp({
          operation: existingId ? 'upsertCosEvent.patch' : 'upsertCosEvent.create',
          googleStatus: res.status,
          detail,
          timeBlockId,
          hasGoogleEventId,
        });
        console.error('google.upsertCosEvent failed', err.toLogFields());
        throw err;
      }
      const data = (await res.json()) as { id?: string };
      const id = data.id ?? existingId ?? `cos-${event.startEpochMs}`;
      console.info('google.upsertCosEvent ok', {
        id,
        timeBlockId: timeBlockId ?? null,
        hasGoogleEventId,
        operation: existingId ? 'update' : 'create',
      });
      return id;
    } catch (err) {
      if (err instanceof GoogleCalendarError) throw err;
      console.error('google.upsertCosEvent error', {
        timeBlockId: timeBlockId ?? null,
        hasGoogleEventId,
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw err;
    }
  }

  async deleteCosEvent(eventId: string): Promise<void> {
    if (eventId.startsWith('cos-')) {
      await this.fallback.deleteCosEvent!(eventId);
      return;
    }
    let accessToken: string;
    try {
      accessToken = await this.bearer('deleteCosEvent');
    } catch (err) {
      if (err instanceof GoogleCalendarError && err.code === 'GOOGLE_NOT_CONNECTED') {
        await this.fallback.deleteCosEvent!(eventId);
        return;
      }
      throw err;
    }
    try {
      const calendarId = await this.ensureCosCalendarId(accessToken);
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok && res.status !== 204 && res.status !== 404 && res.status !== 410) {
        const detail = await res.text();
        console.error(
          'google.deleteCosEvent failed',
          googleErrorFromHttp({
            operation: 'deleteCosEvent',
            googleStatus: res.status,
            detail,
            hasGoogleEventId: true,
          }).toLogFields(),
        );
      } else {
        console.info('google.deleteCosEvent ok', { googleStatus: res.status, hasGoogleEventId: true });
      }
    } catch (err) {
      console.error('google.deleteCosEvent error', {
        hasGoogleEventId: true,
        message: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
}
