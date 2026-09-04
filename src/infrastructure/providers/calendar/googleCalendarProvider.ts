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

const COS_CALENDAR_NAMES = ['Personal OS', 'Personal Planner', 'Personal Chief of Staff'] as const;
const PLANNER_TZ = 'Asia/Ho_Chi_Minh';
const PLANNER_TZ_OFFSET = '+07:00';
/** Dark green for the Personal OS write calendar in Google's sidebar. */
const POS_CALENDAR_APPEARANCE = {
  selected: true,
  hidden: false,
  backgroundColor: '#166534',
  foregroundColor: '#ffffff',
} as const;

export function parseConfiguredReadCalendarIds(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(
    raw.split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )];
}

/** Normalize Google start/end — date-only values use Asia/Ho_Chi_Minh midnight. */
export function parseGoogleEventBounds(
  start?: { dateTime?: string; date?: string },
  end?: { dateTime?: string; date?: string },
): { startEpochMs: number; endEpochMs: number; allDay: boolean } | null {
  const allDay = Boolean(start?.date && end?.date && !start.dateTime && !end.dateTime);
  const startRaw = start?.dateTime ?? (start?.date ? `${start.date}T00:00:00${PLANNER_TZ_OFFSET}` : null);
  const endRaw = end?.dateTime ?? (end?.date ? `${end.date}T00:00:00${PLANNER_TZ_OFFSET}` : null);
  if (!startRaw || !endRaw) return null;
  const startEpochMs = Date.parse(startRaw);
  const endEpochMs = Date.parse(endRaw);
  if (Number.isNaN(startEpochMs) || Number.isNaN(endEpochMs) || endEpochMs <= startEpochMs) return null;
  return { startEpochMs, endEpochMs, allDay };
}

export type GoogleCalendarProviderOptions = {
  /** Previously stored write calendar for this user. */
  writeCalendarId?: string | null;
  /** Persist newly resolved/created write calendar id for this user. */
  onWriteCalendarResolved?: (calendarId: string) => Promise<void>;
  /** Optional extra EXTERNAL calendar IDs (legacy env / per-user later). */
  extraReadCalendarIds?: string[];
};

/**
 * Google Calendar adapter (per-user tokens injected via getTokens/refreshTokens).
 * - WRITE: stored writeCalendarId, or find/create "Personal OS" / legacy names
 * - READ (EXTERNAL): primary + selected calendars; excludes this user's write calendar
 */
export class GoogleCalendarProvider implements CalendarProvider {
  private readonly fallback = new FakeCalendarProvider();
  private resolvedCosCalendarId: string | null = null;
  private readonly extraReadCalendarIds: string[];
  private readonly onWriteCalendarResolved?: (calendarId: string) => Promise<void>;

  constructor(
    private readonly getTokens: () => Promise<TokenBundle | null>,
    private readonly refreshTokens: () => Promise<TokenBundle | null>,
    options: GoogleCalendarProviderOptions | string | undefined = undefined,
    extraReadCalendarIdsLegacy: string[] = [],
  ) {
    // Backward-compatible ctor: (get, refresh, cosCalendarId?, extraIds?)
    if (typeof options === 'string' || options === undefined) {
      if (options) this.resolvedCosCalendarId = options;
      this.extraReadCalendarIds = extraReadCalendarIdsLegacy;
      this.onWriteCalendarResolved = undefined;
    } else {
      if (options.writeCalendarId) this.resolvedCosCalendarId = options.writeCalendarId;
      this.extraReadCalendarIds = options.extraReadCalendarIds ?? [];
      this.onWriteCalendarResolved = options.onWriteCalendarResolved;
    }
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
          status?: string;
          summary?: string;
          location?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          extendedProperties?: { private?: Record<string, string> };
        }>;
      };
      for (const item of data.items ?? []) {
        if (!item.id) continue;
        if (item.status === 'cancelled') continue;
        const bounds = parseGoogleEventBounds(item.start, item.end);
        if (!bounds) continue;
        events.push({
          eventId: item.id,
          title: item.summary ?? 'Busy',
          startEpochMs: bounds.startEpochMs,
          endEpochMs: bounds.endEpochMs,
          allDay: bounds.allDay,
          location: item.location ?? null,
          calendarId,
          appMetadata: item.extendedProperties?.private,
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return events;
  }

  /** Calendars to read as EXTERNAL (never writes here). */
  private async resolveExternalCalendarIds(accessToken: string): Promise<string[]> {
    const ids = new Set<string>(['primary', ...this.extraReadCalendarIds]);
    const excludeIds = new Set<string>();
    if (this.resolvedCosCalendarId) excludeIds.add(this.resolvedCosCalendarId);
    const cosNames = new Set(COS_CALENDAR_NAMES.map((n) => n.toLowerCase()));

    const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (listRes.ok) {
      const data = (await listRes.json()) as {
        items?: Array<{
          id?: string;
          summary?: string;
          selected?: boolean;
          primary?: boolean;
          accessRole?: string;
        }>;
      };
      for (const item of data.items ?? []) {
        if (!item.id) continue;
        if (item.summary && cosNames.has(item.summary.toLowerCase())) {
          excludeIds.add(item.id);
          if (!this.resolvedCosCalendarId) this.resolvedCosCalendarId = item.id;
          continue;
        }
        // Match Google UI: include calendars the user has selected as visible.
        if (item.selected === false) continue;
        if (item.accessRole === 'none') continue;
        ids.add(item.id);
      }
      console.info('google.externalCalendars', {
        count: [...ids].filter((id) => !excludeIds.has(id)).length,
        via: 'calendarList+configured',
      });
    } else {
      const detail = await listRes.text();
      console.error('google.calendarList for read failed', {
        googleStatus: listRes.status,
        ...parseGoogleErrorBody(detail),
      });
      // Fall back to primary + explicit IDs when list scope is missing.
    }

    return [...ids].filter((id) => !excludeIds.has(id));
  }

  async listEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]> {
    try {
      const accessToken = await this.bearer('listEvents');
      const calendarIds = await this.resolveExternalCalendarIds(accessToken);
      const pages = await Promise.all(
        calendarIds.map((calendarId) =>
          this.fetchEvents(accessToken, calendarId, fromEpochMs, toEpochMs, 'listEvents')
            .catch((err) => {
              // One bad calendar must not fail the whole EXTERNAL pull.
              console.error('google.listEvents calendar failed', {
                calendarId,
                ...(err instanceof GoogleCalendarError
                  ? err.toLogFields()
                  : { message: err instanceof Error ? err.message : 'unknown' }),
              });
              return [] as CalendarEvent[];
            }),
        ),
      );
      const byKey = new Map<string, CalendarEvent>();
      for (const event of pages.flat()) {
        const key = `${event.calendarId ?? 'primary'}:${event.eventId}`;
        byKey.set(key, event);
      }
      return [...byKey.values()];
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

  /** Resolve or create the dedicated Personal OS write calendar — never primary / "Ha Son". */
  private async ensureCosCalendarId(accessToken: string): Promise<string> {
    const list = await this.fetchCalendarList(accessToken);
    const dedicated = (item: { id?: string; summary?: string; primary?: boolean } | undefined) => {
      if (!item?.id || item.id === 'primary' || item.primary) return false;
      if (!item.summary) return false;
      return COS_CALENDAR_NAMES.some((n) => n.toLowerCase() === item.summary!.toLowerCase());
    };

    // Cached / stored id is only valid if it is still a dedicated CoS calendar.
    // Legacy env sometimes pointed at primary (shown as the user's name, e.g. "Ha Son").
    if (this.resolvedCosCalendarId && this.resolvedCosCalendarId !== 'primary') {
      const cached = list.find((c) => c.id === this.resolvedCosCalendarId);
      if (dedicated(cached)) {
        await this.ensureWriteCalendarAppearance(accessToken, this.resolvedCosCalendarId);
        return this.resolvedCosCalendarId;
      }
      console.warn('google.cosCalendar rejecting non-dedicated write calendar', {
        calendarId: this.resolvedCosCalendarId,
        summary: cached?.summary ?? null,
        primary: cached?.primary ?? null,
      });
      this.resolvedCosCalendarId = null;
    }

    const match = list.find((c) => dedicated(c));
    if (match?.id) {
      this.resolvedCosCalendarId = match.id;
      console.info('google.cosCalendar resolved', { calendarId: match.id, summary: match.summary });
      await this.ensureWriteCalendarAppearance(accessToken, match.id);
      if (this.onWriteCalendarResolved) await this.onWriteCalendarResolved(match.id);
      return match.id;
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

    // Insert into My calendars with dark-green appearance.
    const listInsert = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: created.id, ...POS_CALENDAR_APPEARANCE }),
    });
    if (!listInsert.ok && listInsert.status !== 409) {
      const detail = await listInsert.text();
      console.warn('google.cosCalendar calendarList insert failed', {
        calendarId: created.id,
        googleStatus: listInsert.status,
        ...parseGoogleErrorBody(detail),
      });
      // 409 = already in list — still apply color.
      await this.ensureWriteCalendarAppearance(accessToken, created.id);
    } else if (listInsert.status === 409) {
      await this.ensureWriteCalendarAppearance(accessToken, created.id);
    }

    this.resolvedCosCalendarId = created.id;
    console.info('google.cosCalendar created', { calendarId: created.id });
    if (this.onWriteCalendarResolved) await this.onWriteCalendarResolved(created.id);
    return created.id;
  }

  /** Keep Personal OS calendar selected + dark green in Google's sidebar. */
  private async ensureWriteCalendarAppearance(accessToken: string, calendarId: string): Promise<void> {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(POS_CALENDAR_APPEARANCE),
      },
    );
    if (!res.ok) {
      const detail = await res.text();
      console.warn('google.cosCalendar appearance patch failed', {
        calendarId,
        googleStatus: res.status,
        ...parseGoogleErrorBody(detail),
      });
    }
  }

  private async fetchCalendarList(accessToken: string): Promise<Array<{
    id?: string;
    summary?: string;
    selected?: boolean;
    primary?: boolean;
    accessRole?: string;
  }>> {
    const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) {
      const detail = await listRes.text();
      console.error('google.calendarList failed', {
        googleStatus: listRes.status,
        ...parseGoogleErrorBody(detail),
      });
      if (listRes.status === 401 || listRes.status === 403) {
        throw googleErrorFromHttp({
          operation: 'ensureCosCalendarId.list',
          googleStatus: listRes.status,
          detail,
        });
      }
      return [];
    }
    const data = (await listRes.json()) as {
      items?: Array<{
        id?: string;
        summary?: string;
        selected?: boolean;
        primary?: boolean;
        accessRole?: string;
      }>;
    };
    return data.items ?? [];
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
      ...(event.colorId ? { colorId: event.colorId } : {}),
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
        colorId: event.colorId ?? null,
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
