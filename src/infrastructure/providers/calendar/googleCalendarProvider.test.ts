import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from './googleCalendarProvider.js';
import {
  googleErrorFromHttp,
  isGoogleCalendarError,
  parseGoogleErrorBody,
} from './googleErrors.js';

describe('googleErrors', () => {
  it('maps auth failures to reconnect-required', () => {
    const err = googleErrorFromHttp({
      operation: 'listEvents',
      googleStatus: 401,
      detail: JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'Invalid Credentials' } }),
    });
    expect(err.code).toBe('GOOGLE_RECONNECT_REQUIRED');
    expect(err.statusCode).toBe(401);
    expect(err.toJSON().reason).toBe('UNAUTHENTICATED');
  });

  it('maps forbidden / not found / rate limit distinctly', () => {
    expect(googleErrorFromHttp({
      operation: 'ensureCosCalendarId.create',
      googleStatus: 403,
      detail: JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
    }).code).toBe('GOOGLE_FORBIDDEN');
    expect(googleErrorFromHttp({
      operation: 'upsertCosEvent.patch',
      googleStatus: 404,
      detail: '{}',
    }).code).toBe('GOOGLE_NOT_FOUND');
    expect(googleErrorFromHttp({
      operation: 'listEvents',
      googleStatus: 429,
      detail: '{}',
    }).code).toBe('GOOGLE_RATE_LIMITED');
    expect(googleErrorFromHttp({
      operation: 'listEvents',
      googleStatus: 503,
      detail: '{}',
    }).code).toBe('GOOGLE_UPSTREAM');
  });

  it('parses nested Google error bodies safely', () => {
    expect(parseGoogleErrorBody('not-json')).toEqual({});
    expect(parseGoogleErrorBody(JSON.stringify({
      error: { errors: [{ reason: 'notFound', message: 'gone' }] },
    }))).toEqual({ reason: 'notFound', message: 'gone' });
  });
});

describe('GoogleCalendarProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('creates a Google event when none exists', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/calendars') && !url.includes('/events') && !url.includes('calendarList') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'cos-cal-1' }), { status: 200 });
      }
      if (url.includes('/calendarList') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'cos-cal-1' }), { status: 200 });
      }
      if (url.includes('/calendarList')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) as { colorId?: string } : {};
        return new Response(JSON.stringify({ id: 'evt-created', colorId: body.colorId }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new GoogleCalendarProvider(
      async () => ({ accessToken: 'access', refreshToken: 'refresh', expiresAt: new Date(Date.now() + 3600_000) }),
      async () => null,
    );
    const id = await provider.upsertCosEvent({
      title: 'Focus',
      startEpochMs: Date.parse('2026-08-23T02:00:00.000Z'),
      endEpochMs: Date.parse('2026-08-23T03:00:00.000Z'),
      colorId: '11',
      appMetadata: { plannerOrigin: 'personal-os', timeBlockId: 'block-1' },
    });
    expect(id).toBe('evt-created');
    const createCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST' && String(init.body).includes('Focus'),
    );
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String(createCall![1]?.body));
    expect(body.start.timeZone).toBe('Asia/Ho_Chi_Minh');
    expect(body.end.timeZone).toBe('Asia/Ho_Chi_Minh');
    expect(body.colorId).toBe('11');
  });

  it('rejects stored primary write calendar and creates Personal OS instead', async () => {
    const onResolved = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/calendarList') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'personal-os-1' }), { status: 200 });
      }
      if (url.includes('/calendarList')) {
        return new Response(JSON.stringify({
          items: [
            { id: 'sonha2002.12@gmail.com', summary: 'Ha Son', primary: true, selected: true },
          ],
        }), { status: 200 });
      }
      if (url.includes('/calendars') && !url.includes('/events') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'personal-os-1' }), { status: 200 });
      }
      if (url.includes('/calendars/personal-os-1/events') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'evt-on-pos' }), { status: 200 });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new GoogleCalendarProvider(
      async () => ({ accessToken: 'access', expiresAt: new Date(Date.now() + 3600_000) }),
      async () => null,
      { writeCalendarId: 'sonha2002.12@gmail.com', onWriteCalendarResolved: onResolved },
    );
    const id = await provider.upsertCosEvent({
      title: 'nice',
      startEpochMs: 1_000,
      endEpochMs: 2_000,
    });
    expect(id).toBe('evt-on-pos');
    expect(onResolved).toHaveBeenCalledWith('personal-os-1');
    const eventUrl = String(fetchMock.mock.calls.find(
      ([url, init]) => init?.method === 'POST' && String(url).includes('/events'),
    )?.[0]);
    expect(eventUrl).toContain('personal-os-1');
    expect(eventUrl).not.toContain('sonha2002');
  });

  it('forces colorId when Google omits it from the PATCH response', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/calendarList')) {
        return new Response(JSON.stringify({
          items: [{ id: 'cos-cal-1', summary: 'Personal OS' }],
        }), { status: 200 });
      }
      if (url.includes('/events/evt-old') && init?.method === 'PATCH') {
        const body = init.body ? JSON.parse(String(init.body)) as { colorId?: string; summary?: string } : {};
        // Full upsert returns without colorId; color-only PATCH persists it.
        if (body.colorId && !body.summary) {
          return new Response(JSON.stringify({ id: 'evt-old', colorId: body.colorId }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 'evt-old' }), { status: 200 });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new GoogleCalendarProvider(
      async () => ({ accessToken: 'access', expiresAt: new Date(Date.now() + 3600_000) }),
      async () => null,
    );
    const id = await provider.upsertCosEvent({
      eventId: 'evt-old',
      title: 'Recolor',
      startEpochMs: 1_000,
      endEpochMs: 2_000,
      colorId: '9',
    });
    expect(id).toBe('evt-old');
    const colorOnly = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PATCH' && String(init.body) === '{"colorId":"9"}',
    );
    expect(colorOnly).toBeTruthy();
  });

  it('updates an existing Google event', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/calendarList')) {
        return new Response(JSON.stringify({
          items: [{ id: 'cos-cal-1', summary: 'Personal Planner' }],
        }), { status: 200 });
      }
      if (url.includes('/events/evt-1') && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ id: 'evt-1' }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const provider = new GoogleCalendarProvider(
      async () => ({ accessToken: 'access', expiresAt: new Date(Date.now() + 3600_000) }),
      async () => null,
    );
    const id = await provider.upsertCosEvent({
      eventId: 'evt-1',
      title: 'Moved',
      startEpochMs: 1_000,
      endEpochMs: 2_000,
    });
    expect(id).toBe('evt-1');
  });

  it('recreates when a stored Google event id is stale (404)', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/calendarList')) {
        return new Response(JSON.stringify({
          items: [{ id: 'cos-cal-1', summary: 'Personal Chief of Staff' }],
        }), { status: 200 });
      }
      if (url.includes('/events/stale') && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'evt-new' }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const provider = new GoogleCalendarProvider(
      async () => ({ accessToken: 'access', expiresAt: new Date(Date.now() + 3600_000) }),
      async () => null,
      'cos-cal-1',
    );
    const id = await provider.upsertCosEvent({
      eventId: 'stale',
      title: 'Recreate me',
      startEpochMs: 1_000,
      endEpochMs: 2_000,
    });
    expect(id).toBe('evt-new');
  });

  it('throws reconnect-required when access is expired and refresh fails', async () => {
    const provider = new GoogleCalendarProvider(
      async () => ({
        accessToken: 'expired',
        refreshToken: 'bad',
        expiresAt: new Date(Date.now() - 60_000),
      }),
      async () => null,
    );
    await expect(provider.listEvents(0, 1)).rejects.toMatchObject({
      code: 'GOOGLE_RECONNECT_REQUIRED',
    });
  });

  it('paginates Events.list until nextPageToken is exhausted', async () => {
    let page = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/calendarList')) {
        return new Response(JSON.stringify({
          items: [{ id: 'primary', summary: 'Primary', selected: true, primary: true }],
        }), { status: 200 });
      }
      if (url.includes('/events')) {
        page += 1;
        if (page === 1) {
          return new Response(JSON.stringify({
            nextPageToken: 'page-2',
            items: [{
              id: 'evt-1',
              summary: 'First page',
              start: { dateTime: '2026-08-17T01:00:00Z' },
              end: { dateTime: '2026-08-17T02:00:00Z' },
            }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          items: [{
            id: 'evt-2',
            summary: 'Second page',
            start: { dateTime: '2026-08-17T03:00:00Z' },
            end: { dateTime: '2026-08-17T04:00:00Z' },
          }],
        }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const provider = new GoogleCalendarProvider(
      async () => ({ accessToken: 'access', expiresAt: new Date(Date.now() + 3600_000) }),
      async () => null,
    );
    const events = await provider.listEvents(0, Date.parse('2026-08-24T00:00:00Z'));
    expect(events.map((e) => e.eventId).sort()).toEqual(['evt-1', 'evt-2']);
  });

  it('throws typed upstream errors instead of opaque strings', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { status: 'INTERNAL' } }), { status: 503 }),
    ) as typeof fetch;
    const provider = new GoogleCalendarProvider(
      async () => ({ accessToken: 'access', expiresAt: new Date(Date.now() + 3600_000) }),
      async () => null,
      'primary',
    );
    try {
      await provider.listCosEvents(0, 1);
      expect.unreachable('should throw');
    } catch (err) {
      expect(isGoogleCalendarError(err)).toBe(true);
      if (isGoogleCalendarError(err)) {
        expect(err.code).toBe('GOOGLE_UPSTREAM');
        expect(err.googleStatus).toBe(503);
      }
    }
  });

  it('normalizes all-day events in Asia/Ho_Chi_Minh and pulls selected non-write calendars', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/calendarList')) {
        return new Response(JSON.stringify({
          items: [
            { id: 'primary', summary: 'Primary', selected: true, primary: true },
            { id: 'sports', summary: 'Thể thao', selected: true },
            { id: 'hidden', summary: 'Hidden', selected: false },
            { id: 'cos-cal', summary: 'Personal Planner', selected: true },
          ],
        }), { status: 200 });
      }
      if (url.includes('/calendars/sports/events')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'all-day-1',
            summary: 'Holiday',
            start: { date: '2026-08-18' },
            end: { date: '2026-08-19' },
          }],
        }), { status: 200 });
      }
      if (url.includes('/calendars/primary/events')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('/calendars/cos-cal/events') || url.includes('/calendars/hidden/events')) {
        throw new Error('should not fetch write/hidden calendars for EXTERNAL list');
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const provider = new GoogleCalendarProvider(
      async () => ({ accessToken: 'access', expiresAt: new Date(Date.now() + 3600_000) }),
      async () => null,
      'cos-cal',
    );
    const events = await provider.listEvents(0, Date.parse('2026-08-24T00:00:00Z'));
    expect(events).toHaveLength(1);
    expect(events[0]?.allDay).toBe(true);
    expect(events[0]?.startEpochMs).toBe(Date.parse('2026-08-18T00:00:00+07:00'));
    expect(events[0]?.endEpochMs).toBe(Date.parse('2026-08-19T00:00:00+07:00'));
  });
});
