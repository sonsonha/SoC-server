import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DeviceService } from '../../application/deviceService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { IntegrationTokenService } from '../../modules/integrations/tokenService.js';
import type { CalendarPullService } from '../../modules/integrations/calendarPullService.js';
import type { FakeCalendarProvider } from '../../infrastructure/providers/calendar/fakeCalendarProvider.js';
import { calendarSyncState } from '../../infrastructure/db/schema/index.js';
import type { Db } from '../../infrastructure/db/client.js';
import type { CalendarProvider } from '../../infrastructure/providers/calendar/types.js';

const connectBody = z.object({
  mode: z.enum(['fake', 'token']).default('fake'),
  // Android kotlinx.serialization may send explicit nulls — accept nullish.
  accessToken: z.string().nullish(),
  refreshToken: z.string().nullish(),
  expiresAt: z.string().datetime().nullish(),
  code: z.string().nullish(),
});

export async function integrationRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    config: AppConfig;
    tokenService: IntegrationTokenService;
    calendarPull: CalendarPullService;
    calendarProvider: CalendarProvider;
    db: Db;
  },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/integrations/google/auth-url', { preHandler: auth }, async (_request, reply) => {
    if (deps.config.USE_FAKE_PROVIDERS || !deps.config.GOOGLE_OAUTH_CLIENT_ID) {
      return reply.send({
        mode: 'fake',
        url: null,
        message: 'Use POST /v1/integrations/google/connect with mode=fake',
      });
    }
    const redirect =
      deps.config.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/v1/integrations/google/callback';
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', deps.config.GOOGLE_OAUTH_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
    );
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    return reply.send({ mode: 'oauth', url: url.toString() });
  });

  app.post('/v1/integrations/google/connect', { preHandler: auth }, async (request, reply) => {
    const body = connectBody.parse(request.body ?? {});
    if (body.mode === 'fake' || deps.config.USE_FAKE_PROVIDERS) {
      await deps.tokenService.saveGoogleCalendarTokens({
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        expiresAt: new Date(Date.now() + 86400_000),
        scopes: 'fake',
      });
      const fake = deps.calendarProvider as FakeCalendarProvider;
      if (typeof fake.seed === 'function' && fake.externalEvents().length === 0) {
        const tomorrow = Date.now() + 86_400_000;
        const start = tomorrow - (tomorrow % 3_600_000) + 15 * 3_600_000;
        fake.seed([
          {
            eventId: 'fake-meeting-1',
            title: 'Synced Google meeting',
            startEpochMs: start,
            endEpochMs: start + 3_600_000,
            location: 'Office',
            calendarId: 'primary',
          },
        ]);
      }
      return reply.send({ connected: true, provider: 'google_calendar', mode: 'fake' });
    }

    if (body.accessToken) {
      await deps.tokenService.saveGoogleCalendarTokens({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        scopes: 'manual',
      });
      return reply.send({ connected: true, provider: 'google_calendar', mode: 'token' });
    }

    if (body.code && deps.config.GOOGLE_OAUTH_CLIENT_ID && deps.config.GOOGLE_OAUTH_CLIENT_SECRET) {
      const redirect =
        deps.config.GOOGLE_OAUTH_REDIRECT_URI ??
        'http://localhost:3000/v1/integrations/google/callback';
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: body.code,
          client_id: deps.config.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: deps.config.GOOGLE_OAUTH_CLIENT_SECRET,
          redirect_uri: redirect,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) {
        return reply.code(400).send({
          error: { code: 'OAUTH_EXCHANGE_FAILED', message: await tokenRes.text() },
        });
      }
      const tokens = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      await deps.tokenService.saveGoogleCalendarTokens({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : null,
        scopes: tokens.scope ?? null,
      });
      return reply.send({ connected: true, provider: 'google_calendar', mode: 'oauth' });
    }

    return reply.code(400).send({
      error: { code: 'INVALID_CONNECT', message: 'Provide mode=fake, accessToken, or OAuth code' },
    });
  });

  app.post('/v1/integrations/google/callback', { preHandler: auth }, async (request, reply) => {
    const body = z.object({ code: z.string() }).parse(request.body ?? {});
    // Reuse connect with OAuth code
    const connect = connectBody.parse({ mode: 'token', code: body.code });
    (request as { body: unknown }).body = connect;
    const result = await app.inject({
      method: 'POST',
      url: '/v1/integrations/google/connect',
      headers: { authorization: request.headers.authorization ?? '' },
      payload: { mode: 'token', code: body.code },
    });
    return reply.code(result.statusCode).send(result.json());
  });

  app.get('/v1/integrations/status', { preHandler: auth }, async (_request, reply) => {
    const connected = await deps.tokenService.isGoogleCalendarConnected();
    const stateRows = await deps.db
      .select()
      .from(calendarSyncState)
      .limit(1);
    const lastSyncAt = stateRows[0]?.lastSyncAt?.toISOString() ?? null;
    const lastReplanAt = stateRows[0]?.lastReplanAt?.toISOString() ?? null;
    return reply.send({
      providers: [
        {
          provider: 'google_calendar',
          connected,
          mode: deps.config.USE_FAKE_PROVIDERS ? 'fake' : 'live',
          lastSyncAt,
          lastReplanAt,
          calendarChanged: Boolean(lastReplanAt && lastSyncAt && lastReplanAt > lastSyncAt),
        },
      ],
    });
  });

  app.delete('/v1/integrations/google', { preHandler: auth }, async (_request, reply) => {
    await deps.tokenService.clearGoogleCalendar();
    return reply.send({ connected: false });
  });

  app.get('/v1/calendar/events', { preHandler: auth }, async (request, reply) => {
    const q = request.query as { from?: string; to?: string };
    const fromEpochMs = q.from ? Date.parse(q.from) : Date.now() - 86_400_000;
    const toEpochMs = q.to ? Date.parse(q.to) : Date.now() + 14 * 86_400_000;
    const events = await deps.calendarPull.listStoredEvents(fromEpochMs, toEpochMs);
    return reply.send({ events });
  });

  app.post('/v1/calendar/sync', { preHandler: auth }, async (_request, reply) => {
    const summary = await deps.calendarPull.pull();
    return reply.send({ ok: true, summary });
  });
}
