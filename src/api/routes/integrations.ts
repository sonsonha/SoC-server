import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DeviceService } from '../../application/deviceService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import { createPlannerAuthHook } from '../middleware/plannerAuth.js';
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

const WEB_PLANNER_RETURN_URL = 'https://personal-os-calendar-planner.terryson821.chatgpt.site';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;

function googleAuthUrl(config: AppConfig, state?: string): { url: string; redirectUri: string } {
  const redirectUri = defaultRedirectUri(config);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set(
    'scope',
    'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events',
  );
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (state) url.searchParams.set('state', state);
  return { url: url.toString(), redirectUri };
}

export function createWebOAuthState(secret: string, now: number = Date.now()): string {
  const payload = `${now}.${randomBytes(18).toString('base64url')}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyWebOAuthState(
  state: string,
  secret: string,
  now: number = Date.now(),
): boolean {
  const [timestamp, nonce, signature] = state.split('.');
  if (!timestamp || !nonce || !signature) return false;
  const createdAt = Number(timestamp);
  if (!Number.isFinite(createdAt) || Math.abs(now - createdAt) > OAUTH_STATE_MAX_AGE_MS) return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}`)
    .digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function defaultRedirectUri(config: AppConfig): string {
  // Prefer explicit Railway var. Keep /callback (your current value) working via GET handler.
  if (config.GOOGLE_OAUTH_REDIRECT_URI) return config.GOOGLE_OAUTH_REDIRECT_URI.trim();
  const publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;
  if (publicUrl) return `${publicUrl}/v1/integrations/google/callback`;
  return 'http://localhost:3000/v1/integrations/google/callback';
}

async function exchangeGoogleCode(
  config: AppConfig,
  code: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}> {
  const redirect = defaultRedirectUri(config);
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: config.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    throw Object.assign(new Error(detail), { statusCode: 400, code: 'OAUTH_EXCHANGE_FAILED' });
  }
  return (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
}

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
  const plannerAuth = createPlannerAuthHook(deps.deviceService, deps.config.PLANNER_WEB_TOKEN);

  app.get('/v1/integrations/google/auth-url', { preHandler: auth }, async (_request, reply) => {
    if (deps.config.USE_FAKE_PROVIDERS || !deps.config.GOOGLE_OAUTH_CLIENT_ID) {
      return reply.send({
        mode: 'fake',
        url: null,
        message: 'Use POST /v1/integrations/google/connect with mode=fake',
      });
    }
    const result = googleAuthUrl(deps.config);
    return reply.send({ mode: 'oauth', url: result.url, redirectUri: result.redirectUri });
  });

  app.get('/v2/integrations/google/auth-url', { preHandler: plannerAuth }, async (_request, reply) => {
    if (deps.config.USE_FAKE_PROVIDERS || !deps.config.GOOGLE_OAUTH_CLIENT_ID) {
      return reply.send({ mode: 'fake', url: null });
    }
    const state = createWebOAuthState(deps.config.DEVICE_AUTH_PEPPER);
    const result = googleAuthUrl(deps.config, state);
    return reply.send({ mode: 'oauth', url: result.url, redirectUri: result.redirectUri });
  });

  /**
   * Google redirects here after consent (browser). No device auth — single-user prototype.
   * Accept both /oauth-callback and /callback so Railway/Google URI typos don't brick connect.
   * GOOGLE_OAUTH_REDIRECT_URI must match Google Cloud Console character-for-character.
   */
  const handleOAuthRedirect = async (request: FastifyRequest, reply: FastifyReply) => {
    const q = z
      .object({
        code: z.string().optional(),
        error: z.string().optional(),
        state: z.string().optional(),
      })
      .parse(request.query ?? {});
    if (q.error) {
      return reply
        .type('text/html')
        .code(400)
        .send(`<h1>Google Calendar connect failed</h1><p>${q.error}</p>`);
    }
    if (!q.code) {
      return reply.type('text/html').code(400).send('<h1>Missing OAuth code</h1>');
    }
    if (!deps.config.GOOGLE_OAUTH_CLIENT_ID || !deps.config.GOOGLE_OAUTH_CLIENT_SECRET) {
      return reply
        .type('text/html')
        .code(500)
        .send('<h1>Server missing GOOGLE_OAUTH_CLIENT_ID / SECRET</h1>');
    }
    try {
      const tokens = await exchangeGoogleCode(deps.config, q.code);
      await deps.tokenService.saveGoogleCalendarTokens({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : null,
        scopes: tokens.scope ?? null,
      });
      if (q.state && verifyWebOAuthState(q.state, deps.config.DEVICE_AUTH_PEPPER)) {
        return reply.redirect(`${WEB_PLANNER_RETURN_URL}/?google=connected`);
      }
      return reply.type('text/html').send(`<!doctype html>
<html><body style="font-family:system-ui;padding:2rem">
  <h1>Google Calendar connected</h1>
  <p>Tokens saved on the server. Return to the app → Plan → <b>Rebuild cloud week</b>.</p>
  <p>You can close this tab.</p>
</body></html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, 'oauth-callback failed');
      return reply
        .type('text/html')
        .code(400)
        .send(`<h1>Token exchange failed</h1><pre>${message}</pre>`);
    }
  };

  app.get('/v1/integrations/google/oauth-callback', handleOAuthRedirect);
  app.get('/v1/integrations/google/callback', handleOAuthRedirect);

  app.post('/v1/integrations/google/connect', { preHandler: auth }, async (request, reply) => {
    const body = connectBody.parse(request.body ?? {});
    const liveConfigured =
      !deps.config.USE_FAKE_PROVIDERS && Boolean(deps.config.GOOGLE_OAUTH_CLIENT_ID);

    if (body.mode === 'fake') {
      if (liveConfigured) {
        // Don't 400 — return the browser URL so the app (or a retry) can open OAuth.
        const result = googleAuthUrl(deps.config);
        return reply.send({
          connected: false,
          provider: 'google_calendar',
          mode: 'oauth_required',
          authUrl: result.url,
          redirectUri: result.redirectUri,
        });
      }
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

    if (deps.config.USE_FAKE_PROVIDERS) {
      return reply.code(400).send({
        error: {
          code: 'FAKE_PROVIDERS',
          message: 'Set USE_FAKE_PROVIDERS=false to connect a real Google account',
        },
      });
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
      try {
        const tokens = await exchangeGoogleCode(deps.config, body.code);
        await deps.tokenService.saveGoogleCalendarTokens({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          expiresAt: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000)
            : null,
          scopes: tokens.scope ?? null,
        });
        return reply.send({ connected: true, provider: 'google_calendar', mode: 'oauth' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({
          error: { code: 'OAUTH_EXCHANGE_FAILED', message },
        });
      }
    }

    return reply.code(400).send({
      error: { code: 'INVALID_CONNECT', message: 'Provide accessToken, OAuth code, or complete browser OAuth' },
    });
  });

  app.post('/v1/integrations/google/callback', { preHandler: auth }, async (request, reply) => {
    const body = z.object({ code: z.string() }).parse(request.body ?? {});
    const result = await app.inject({
      method: 'POST',
      url: '/v1/integrations/google/connect',
      headers: { authorization: request.headers.authorization ?? '' },
      payload: { mode: 'token', code: body.code },
    });
    return reply.code(result.statusCode).send(result.json());
  });

  const integrationStatus = async (_request: FastifyRequest, reply: FastifyReply) => {
    const tokens = await deps.tokenService.getGoogleCalendarTokens();
    const isFakeToken = tokens?.accessToken === 'fake-access-token';
    const connected = Boolean(tokens) && !isFakeToken;
    const stateRows = await deps.db.select().from(calendarSyncState).limit(1);
    const lastSyncAt = stateRows[0]?.lastSyncAt?.toISOString() ?? null;
    const lastReplanAt = stateRows[0]?.lastReplanAt?.toISOString() ?? null;
    const mode = deps.config.USE_FAKE_PROVIDERS || isFakeToken ? 'fake' : connected ? 'live' : 'none';
    return reply.send({
      providers: [
        {
          provider: 'google_calendar',
          connected: connected || (deps.config.USE_FAKE_PROVIDERS && Boolean(tokens)),
          mode,
          lastSyncAt,
          lastReplanAt,
          calendarChanged: Boolean(lastReplanAt && lastSyncAt && lastReplanAt > lastSyncAt),
        },
      ],
    });
  };

  app.get('/v1/integrations/status', { preHandler: auth }, integrationStatus);
  app.get('/v2/integrations/status', { preHandler: plannerAuth }, integrationStatus);

  app.delete('/v1/integrations/google', { preHandler: auth }, async (_request, reply) => {
    await deps.tokenService.clearGoogleCalendar();
    return reply.send({ connected: false });
  });
  app.delete('/v2/integrations/google', { preHandler: plannerAuth }, async (_request, reply) => {
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

  const syncCalendar = async (_request: FastifyRequest, reply: FastifyReply) => {
    const summary = await deps.calendarPull.pull();
    return reply.send({ ok: true, summary });
  };

  app.post('/v1/calendar/sync', { preHandler: auth }, syncCalendar);
  app.post('/v2/calendar/sync', { preHandler: plannerAuth }, syncCalendar);
}
