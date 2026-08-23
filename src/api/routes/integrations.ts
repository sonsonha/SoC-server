import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DeviceService } from '../../application/deviceService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import { createPlannerAuthHook } from '../middleware/plannerAuth.js';
import type { IntegrationTokenService } from '../../modules/integrations/tokenService.js';
import type { CalendarPullService } from '../../modules/integrations/calendarPullService.js';
import { calendarSyncState } from '../../infrastructure/db/schema/index.js';
import type { Db } from '../../infrastructure/db/client.js';
import type { PlannerV2Service } from '../../application/plannerV2Service.js';
import type { IdentityService } from '../../modules/identity/identityService.js';
import { createPersonalOsUserHook } from '../middleware/personalOsAuth.js';
import {
  isGoogleCalendarError,
  type GoogleCalendarErrorCode,
} from '../../infrastructure/providers/calendar/googleErrors.js';
import {
  OAuthConnectionStateService,
  fetchGoogleAccountIdentity,
} from '../../modules/integrations/oauthConnectionState.js';
import { createUserCalendarProviderAsync } from '../../modules/integrations/userCalendarProvider.js';
import {
  oauthErrorRedirectUrl,
  oauthSuccessRedirectUrl,
  resolvePlannerWebReturnUrl,
} from './oauthReturnUrl.js';

/** Per-user last sync failure for status — not secrets, safe codes only. */
const lastGoogleSyncError = new Map<
  string,
  {
    code: GoogleCalendarErrorCode | string;
    message: string;
    googleStatus: number | null;
    at: string;
  }
>();

const connectBody = z.object({
  mode: z.enum(['fake', 'token']).default('fake'),
  // Android kotlinx.serialization may send explicit nulls — accept nullish.
  accessToken: z.string().nullish(),
  refreshToken: z.string().nullish(),
  expiresAt: z.string().datetime().nullish(),
  code: z.string().nullish(),
});

const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;
const GOOGLE_OPENID_SCOPE = 'openid';
const GOOGLE_EMAIL_SCOPE = 'email';
const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_CALENDAR_MANAGE_SCOPE = 'https://www.googleapis.com/auth/calendar.calendars';
const GOOGLE_CALENDAR_LIST_SCOPE =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly';

export function googleAuthUrl(
  config: AppConfig,
  state?: string,
): { url: string; redirectUri: string; scopes: string[] } {
  const redirectUri = defaultRedirectUri(config);
  // Always request openid/email (account binding) + calendarlist + calendars manage
  // so each user can create a Personal OS write calendar. Do not gate on
  // GOOGLE_COS_CALENDAR_ID (legacy shared write calendar).
  const scopes = [
    GOOGLE_OPENID_SCOPE,
    GOOGLE_EMAIL_SCOPE,
    GOOGLE_CALENDAR_EVENTS_SCOPE,
    GOOGLE_CALENDAR_LIST_SCOPE,
    GOOGLE_CALENDAR_MANAGE_SCOPE,
  ];
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  // Durable offline access — required for Sync after the access token expires.
  url.searchParams.set('access_type', 'offline');
  // Force consent so Google issues a refresh_token on Connect and Reconnect.
  url.searchParams.set('prompt', 'consent');
  if (state) url.searchParams.set('state', state);
  return { url: url.toString(), redirectUri, scopes };
}

/** Calendar scopes that must be granted (openid/email verified via userinfo separately). */
export const REQUIRED_GOOGLE_CALENDAR_SCOPES = [
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_LIST_SCOPE,
  GOOGLE_CALENDAR_MANAGE_SCOPE,
] as const;

export function googleScopesSatisfied(grantedRaw: string | null | undefined): boolean {
  if (!grantedRaw?.trim()) return false;
  const granted = new Set(grantedRaw.split(/\s+/).filter(Boolean));
  return REQUIRED_GOOGLE_CALENDAR_SCOPES.every((scope) => granted.has(scope));
}

/** HMAC state helpers — kept for backward-compat unit tests; V2 uses OAuthConnectionStateService. */
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
  if (publicUrl) return `${publicUrl}/v1/integrations/google/oauth-callback`;
  return 'http://localhost:3000/v1/integrations/google/oauth-callback';
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

function setSyncError(
  userId: string,
  err: {
    code: GoogleCalendarErrorCode | string;
    message: string;
    googleStatus: number | null;
  },
): void {
  lastGoogleSyncError.set(userId, { ...err, at: new Date().toISOString() });
}

function clearSyncError(userId: string): void {
  lastGoogleSyncError.delete(userId);
}

export async function integrationRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    config: AppConfig;
    tokenService: IntegrationTokenService;
    calendarPull: CalendarPullService;
    plannerV2: PlannerV2Service;
    db: Db;
    identity: IdentityService;
    oauthStates: OAuthConnectionStateService;
  },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);
  const serviceAuth = createPlannerAuthHook(deps.deviceService, deps.config.PLANNER_WEB_TOKEN);
  const userAuth = createPersonalOsUserHook(deps.identity);
  const plannerAuth = [serviceAuth, userAuth];

  /**
   * Mobile / device (V1) Calendar is owner-only: all token + sync operations map to
   * `identity.resolveInitialOwnerUser()`. If the initial owner is unset or has never
   * signed in, return 403 DEVICE_PLANNER_OWNER_REQUIRED.
   */
  const requireOwnerUserId = async (
    reply: FastifyReply,
  ): Promise<string | null> => {
    const owner = await deps.identity.resolveInitialOwnerUser();
    if (!owner) {
      await reply.code(403).send({
        error: {
          code: 'DEVICE_PLANNER_OWNER_REQUIRED',
          message:
            'Configure PERSONAL_OS_INITIAL_OWNER_EMAIL and have that user sign in before Calendar on device',
        },
      });
      return null;
    }
    return owner.id;
  };

  const buildProviderStatus = async (userId: string) => {
    const status = await deps.tokenService.getPublicStatus(userId, {
      useFakeProviders: deps.config.USE_FAKE_PROVIDERS,
    });
    const stateRows = await deps.db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.userId, userId))
      .limit(1);
    const syncLastAt = stateRows[0]?.lastSyncAt?.toISOString() ?? null;
    const lastSyncAt = syncLastAt ?? status.lastSyncAt;
    const syncErr = lastGoogleSyncError.get(userId);
    const lastError = syncErr
      ? {
          code: syncErr.code,
          message: syncErr.message,
          googleStatus: syncErr.googleStatus,
          at: syncErr.at,
        }
      : status.lastErrorCode
        ? {
            code: status.lastErrorCode,
            message: status.lastErrorCode,
            googleStatus: null,
            at: null,
          }
        : null;
    return {
      provider: 'google_calendar' as const,
      connected: status.connected,
      healthy: status.healthy && !syncErr,
      reconnectRequired:
        status.reconnectRequired
        || syncErr?.code === 'GOOGLE_RECONNECT_REQUIRED',
      mode: status.mode,
      googleAccountEmail: status.googleAccountEmail,
      lastSyncAt,
      lastError,
      writeCalendarId: status.writeCalendarId,
    };
  };

  const runCalendarSync = async (userId: string, reply: FastifyReply) => {
    try {
      const summary = await deps.calendarPull.pull(userId);
      if (summary.reconnectRequired || summary.errorCode === 'GOOGLE_RECONNECT_REQUIRED') {
        await deps.tokenService.markReconnectRequired(
          userId,
          summary.errorCode ?? 'GOOGLE_RECONNECT_REQUIRED',
        );
        setSyncError(userId, {
          code: summary.errorCode ?? 'GOOGLE_RECONNECT_REQUIRED',
          message: summary.errorMessage ?? 'Google Calendar reconnect required',
          googleStatus: summary.googleStatus ?? null,
        });
        return reply.code(401).send({
          ok: false,
          error: {
            code: lastGoogleSyncError.get(userId)!.code,
            message: lastGoogleSyncError.get(userId)!.message,
            googleStatus: lastGoogleSyncError.get(userId)!.googleStatus,
          },
          summary: {
            ...summary,
            retry: { attempted: 0, synced: 0, failed: 0 },
          },
        });
      }

      const retry = summary.connected
        ? await deps.plannerV2.retryCalendarSync(userId)
        : { attempted: 0, synced: 0, failed: 0 };

      if (summary.errorCode) {
        // Permission / upstream errors must not force an OAuth reconnect loop.
        if (summary.errorCode === 'GOOGLE_RECONNECT_REQUIRED') {
          await deps.tokenService.markReconnectRequired(userId, summary.errorCode);
        }
        setSyncError(userId, {
          code: summary.errorCode,
          message: summary.errorMessage ?? 'Google Calendar sync degraded',
          googleStatus: summary.googleStatus ?? null,
        });
      } else {
        await deps.tokenService.touchLastSync(userId);
        clearSyncError(userId);
      }

      return reply.send({ ok: true, summary: { ...summary, retry } });
    } catch (err) {
      if (isGoogleCalendarError(err)) {
        if (err.code === 'GOOGLE_RECONNECT_REQUIRED') {
          await deps.tokenService.markReconnectRequired(userId, err.code);
        }
        setSyncError(userId, {
          code: err.code,
          message: err.message,
          googleStatus: err.googleStatus ?? null,
        });
        console.error('calendar.sync failed', err.toLogFields());
        return reply.code(err.statusCode).send({
          ok: false,
          error: err.toJSON(),
          summary: {
            fetched: 0,
            upserted: 0,
            removed: 0,
            ownedUpdated: 0,
            ownedRemoved: 0,
            replannedDates: [],
            connected: false,
            reconnectRequired: err.code === 'GOOGLE_RECONNECT_REQUIRED',
            errorCode: err.code,
            errorMessage: err.message,
            googleStatus: err.googleStatus ?? null,
            retry: { attempted: 0, synced: 0, failed: 0 },
          },
        });
      }
      console.error('calendar.sync unexpected error', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw err;
    }
  };

  app.get('/v1/integrations/google/auth-url', { preHandler: auth }, async (_request, reply) => {
    if (deps.config.USE_FAKE_PROVIDERS || !deps.config.GOOGLE_OAUTH_CLIENT_ID) {
      return reply.send({
        mode: 'fake',
        url: null,
        message: 'Use POST /v1/integrations/google/connect with mode=fake',
      });
    }
    const result = googleAuthUrl(deps.config);
    return reply.send({
      mode: 'oauth',
      url: result.url,
      redirectUri: result.redirectUri,
      scopes: result.scopes,
    });
  });

  app.get('/v2/integrations/google/auth-url', { preHandler: plannerAuth }, async (request, reply) => {
    if (!request.posUser) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Sign in required to connect Google Calendar' },
      });
    }
    if (deps.config.USE_FAKE_PROVIDERS || !deps.config.GOOGLE_OAUTH_CLIENT_ID) {
      return reply.send({ mode: 'fake', url: null });
    }
    const { rawState } = await deps.oauthStates.create(request.posUser.id);
    const result = googleAuthUrl(deps.config, rawState);
    app.log.info({
      event: 'oauth.auth_url',
      userId: request.posUser.id,
      stateCreated: true,
      redirectUri: result.redirectUri,
      scopeCount: result.scopes.length,
    }, 'calendar oauth state created');
    return reply.send({
      mode: 'oauth',
      url: result.url,
      redirectUri: result.redirectUri,
      scopes: result.scopes,
    });
  });

  /**
   * Google redirects here after consent (browser). No device/session cookie —
   * user binding comes from oauthStates.consume(state).
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

    let webReturnConfigured = true;
    try {
      resolvePlannerWebReturnUrl(deps.config);
    } catch {
      webReturnConfigured = false;
    }

    const redirectOrHtml = (kind: 'success' | 'error', reason?: string) => {
      if (!webReturnConfigured) {
        const message = kind === 'success'
          ? 'Google Calendar connected, but PLANNER_WEB_RETURN_URL is not set to your Vercel origin on Railway.'
          : `Google Calendar connect failed (${reason ?? 'error'}). Set PLANNER_WEB_RETURN_URL to your Vercel origin.`;
        return reply
          .type('text/html')
          .code(kind === 'success' ? 200 : 400)
          .send(`<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>${
            kind === 'success' ? 'Connected' : 'Connect failed'
          }</h1><p>${message}</p><p>Do not use *.chatgpt.site.</p></body></html>`);
      }
      try {
        const target = kind === 'success'
          ? oauthSuccessRedirectUrl(deps.config)
          : oauthErrorRedirectUrl(deps.config, reason);
        return reply.redirect(target);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply
          .type('text/html')
          .code(500)
          .send(`<h1>OAuth return URL misconfigured</h1><pre>${message}</pre>`);
      }
    };

    if (q.error) {
      return redirectOrHtml('error', q.error);
    }
    if (!q.code) {
      return redirectOrHtml('error', 'missing_code');
    }
    if (!deps.config.GOOGLE_OAUTH_CLIENT_ID || !deps.config.GOOGLE_OAUTH_CLIENT_SECRET) {
      return reply
        .type('text/html')
        .code(500)
        .send('<h1>Server missing GOOGLE_OAUTH_CLIENT_ID / SECRET</h1>');
    }

    const userId = await deps.oauthStates.consume(q.state);
    if (!userId) {
      app.log.warn({
        event: 'oauth.callback',
        statePresent: Boolean(q.state),
        stateValid: false,
        stateConsumed: false,
        resolvedUserId: null,
        status: 'invalid_state',
        errorCode: 'INVALID_OAUTH_STATE',
      }, 'calendar oauth state missing/expired/replayed');
      return redirectOrHtml('error', 'invalid_state');
    }

    app.log.info({
      event: 'oauth.callback',
      statePresent: Boolean(q.state),
      stateValid: true,
      stateConsumed: true,
      resolvedUserId: userId,
      status: 'state_ok',
    }, 'calendar oauth state consumed');

    try {
      const tokens = await exchangeGoogleCode(deps.config, q.code);
      const googleIdentity = await fetchGoogleAccountIdentity(tokens.access_token);
      if (!googleIdentity) {
        app.log.warn({
          event: 'oauth.callback',
          userId,
          tokenExchange: true,
          hasAccessToken: Boolean(tokens.access_token),
          hasRefreshToken: Boolean(tokens.refresh_token),
          googleSubObtained: false,
          status: 'account_mismatch',
          errorCode: 'GOOGLE_ACCOUNT_MISMATCH',
        }, 'google identity missing from access token');
        return redirectOrHtml('error', 'account_mismatch');
      }

      const user = await deps.identity.getUserById(userId);
      if (!user) {
        return redirectOrHtml('error', 'invalid_state');
      }
      const accountMatch = googleIdentity.sub === user.googleSub;
      // GOOGLE_ACCOUNT_MISMATCH — signed-in Personal OS user must match Google account.
      if (!accountMatch) {
        app.log.warn({
          event: 'oauth.callback',
          userId,
          personalOsGoogleSubPresent: Boolean(user.googleSub),
          googleSubObtained: true,
          accountMatch: false,
          hasAccessToken: Boolean(tokens.access_token),
          hasRefreshToken: Boolean(tokens.refresh_token),
          scopeCount: tokens.scope?.split(/\s+/).filter(Boolean).length ?? 0,
          status: 'account_mismatch',
          errorCode: 'GOOGLE_ACCOUNT_MISMATCH',
        }, 'calendar oauth account mismatch');
        return redirectOrHtml('error', 'account_mismatch');
      }

      // Orphan/legacy repair is ONLY for the explicit initial owner — never User B.
      const isInitialOwner = deps.identity.isLegacyCalendarOwner(user.email);
      const existing = await deps.tokenService.getGoogleCalendarTokens(userId);
      const orphan =
        !existing && isInitialOwner
          ? await deps.tokenService.getOrphanGoogleCalendarTokens()
          : null;
      const effectiveRefresh =
        tokens.refresh_token?.trim()
        || existing?.refreshToken
        || orphan?.refreshToken
        || null;
      if (!effectiveRefresh) {
        app.log.warn({
          event: 'oauth.callback',
          userId,
          accountMatch: true,
          tokenExchange: true,
          hasAccessToken: Boolean(tokens.access_token),
          hasRefreshToken: false,
          orphanRefreshAvailable: false,
          isInitialOwner,
          scopeCount: tokens.scope?.split(/\s+/).filter(Boolean).length ?? 0,
          writeCalendarResolved: false,
          upsertAttempted: false,
          status: 'missing_refresh_token',
          errorCode: 'MISSING_REFRESH_TOKEN',
        }, 'calendar oauth missing refresh_token');
        return redirectOrHtml('error', 'missing_refresh_token');
      }

      if (tokens.scope && !googleScopesSatisfied(tokens.scope)) {
        app.log.warn({
          event: 'oauth.callback',
          userId,
          accountMatch: true,
          hasAccessToken: true,
          hasRefreshToken: true,
          scopeCount: tokens.scope.split(/\s+/).filter(Boolean).length,
          writeCalendarResolved: false,
          upsertAttempted: false,
          status: 'insufficient_scopes',
          errorCode: 'GOOGLE_FORBIDDEN',
        }, 'calendar oauth missing required scopes');
        return redirectOrHtml('error', 'insufficient_scopes');
      }

      let saved: {
        preservedRefreshToken: boolean;
        hasRefreshToken: boolean;
        claimedOrphan: boolean;
      };
      try {
        saved = await deps.tokenService.saveGoogleCalendarTokens(
          userId,
          {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            expiresAt: tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000)
              : null,
            scopes: tokens.scope ?? null,
            googleAccountSub: googleIdentity.sub,
            googleAccountEmail: googleIdentity.email,
            status: 'connected',
            lastErrorCode: null,
          },
          { allowOrphanClaim: isInitialOwner },
        );
      } catch (upsertErr) {
        const message = upsertErr instanceof Error ? upsertErr.message : String(upsertErr);
        app.log.error({
          event: 'oauth.callback',
          userId,
          accountMatch: true,
          hasAccessToken: true,
          hasRefreshToken: Boolean(effectiveRefresh),
          upsertAttempted: true,
          upsertSucceeded: false,
          status: 'upsert_failed',
          errorCode: 'INTEGRATION_UPSERT_FAILED',
          dbError: message.slice(0, 200),
        }, 'calendar oauth integration_tokens upsert failed');
        return redirectOrHtml('error', 'upsert_failed');
      }
      clearSyncError(userId);

      app.log.info({
        event: 'oauth.callback',
        userId,
        accountMatch: true,
        tokenExchange: true,
        hasAccessToken: true,
        hasRefreshToken: saved.hasRefreshToken,
        preservedRefreshToken: saved.preservedRefreshToken,
        claimedOrphan: saved.claimedOrphan,
        tokenExpiryPresent: Boolean(tokens.expires_in),
        scopeCount: tokens.scope?.split(/\s+/).filter(Boolean).length ?? 0,
        upsertAttempted: true,
        upsertSucceeded: true,
        status: 'tokens_persisted',
      }, 'calendar oauth tokens persisted');

      let writeCalendarResolved = false;
      try {
        const provider = await createUserCalendarProviderAsync({
          userId,
          tokenService: deps.tokenService,
          config: deps.config,
          // Never inject GOOGLE_COS_CALENDAR_ID for second users.
          allowLegacyCosCalendarFallback: isInitialOwner,
        });
        if (provider.listCosEvents) {
          const now = Date.now();
          await provider.listCosEvents(now, now + 60_000);
          writeCalendarResolved = true;
        }
      } catch (writeErr) {
        const code = isGoogleCalendarError(writeErr) ? writeErr.code : 'WRITE_CALENDAR_FAILED';
        app.log.warn({
          event: 'oauth.callback',
          userId,
          accountMatch: true,
          hasAccessToken: true,
          hasRefreshToken: saved.hasRefreshToken,
          preservedRefreshToken: saved.preservedRefreshToken,
          claimedOrphan: saved.claimedOrphan,
          scopeCount: tokens.scope?.split(/\s+/).filter(Boolean).length ?? 0,
          upsertSucceeded: true,
          writeCalendarResolved: false,
          status: 'write_calendar_failed',
          errorCode: code,
        }, 'write calendar resolve failed after oauth — tokens kept');
        // Tokens remain persisted; do not claim connected success.
        if (code === 'GOOGLE_FORBIDDEN') {
          return redirectOrHtml('error', 'insufficient_scopes');
        }
        return redirectOrHtml('error', 'write_calendar_failed');
      }

      const status = await deps.tokenService.getPublicStatus(userId);
      app.log.info({
        event: 'oauth.callback',
        userId,
        accountMatch: true,
        hasAccessToken: true,
        hasRefreshToken: saved.hasRefreshToken,
        preservedRefreshToken: saved.preservedRefreshToken,
        claimedOrphan: saved.claimedOrphan,
        tokenExpiryPresent: Boolean(tokens.expires_in),
        scopeCount: tokens.scope?.split(/\s+/).filter(Boolean).length ?? 0,
        writeCalendarResolved,
        writeCalendarIdPresent: Boolean(status.writeCalendarId),
        connected: status.connected,
        healthy: status.healthy,
        reconnectRequired: status.reconnectRequired,
        status: 'connected',
        errorCode: null,
        finalRedirect: 'google=connected',
      }, 'calendar oauth callback success');

      if (webReturnConfigured) {
        return redirectOrHtml('success');
      }
      return reply.type('text/html').send(`<!doctype html>
<html><body style="font-family:system-ui;padding:2rem">
  <h1>Google Calendar connected</h1>
  <p>Tokens saved on the server. Return to Personal OS on Vercel.</p>
  <p>You can close this tab.</p>
</body></html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err, event: 'oauth.callback', userId, status: 'token_exchange_failed' }, 'oauth-callback failed');
      if (webReturnConfigured) {
        return redirectOrHtml('error', 'token_exchange_failed');
      }
      return reply
        .type('text/html')
        .code(400)
        .send(`<h1>Token exchange failed</h1><pre>${message}</pre>`);
    }
  };

  app.get('/v1/integrations/google/oauth-callback', handleOAuthRedirect);
  app.get('/v1/integrations/google/callback', handleOAuthRedirect);

  // Mobile device connect — owner-only (see requireOwnerUserId comment above).
  app.post('/v1/integrations/google/connect', { preHandler: auth }, async (request, reply) => {
    const owner = await deps.identity.resolveInitialOwnerUser();
    if (!owner) {
      return reply.code(403).send({
        error: {
          code: 'DEVICE_PLANNER_OWNER_REQUIRED',
          message:
            'Configure PERSONAL_OS_INITIAL_OWNER_EMAIL and have that user sign in before Calendar on device',
        },
      });
    }

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
      await deps.tokenService.saveGoogleCalendarTokens(
        owner.id,
        {
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          expiresAt: new Date(Date.now() + 86400_000),
          scopes: 'fake',
          googleAccountSub: owner.googleSub,
          googleAccountEmail: owner.email,
        },
        { allowOrphanClaim: true },
      );
      clearSyncError(owner.id);
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
      await deps.tokenService.saveGoogleCalendarTokens(
        owner.id,
        {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken ?? null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          scopes: 'manual',
          googleAccountSub: owner.googleSub,
          googleAccountEmail: owner.email,
        },
        { allowOrphanClaim: true },
      );
      clearSyncError(owner.id);
      return reply.send({ connected: true, provider: 'google_calendar', mode: 'token' });
    }

    if (body.code && deps.config.GOOGLE_OAUTH_CLIENT_ID && deps.config.GOOGLE_OAUTH_CLIENT_SECRET) {
      try {
        const tokens = await exchangeGoogleCode(deps.config, body.code);
        const googleIdentity = await fetchGoogleAccountIdentity(tokens.access_token);
        await deps.tokenService.saveGoogleCalendarTokens(
          owner.id,
          {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            expiresAt: tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000)
              : null,
            scopes: tokens.scope ?? null,
            googleAccountSub: googleIdentity?.sub ?? owner.googleSub,
            googleAccountEmail: googleIdentity?.email ?? owner.email,
          },
          { allowOrphanClaim: true },
        );
        clearSyncError(owner.id);
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

  app.get('/v1/integrations/status', { preHandler: auth }, async (_request, reply) => {
    const ownerId = await requireOwnerUserId(reply);
    if (!ownerId) return;
    const provider = await buildProviderStatus(ownerId);
    return reply.send({ providers: [provider] });
  });

  app.get('/v2/integrations/status', { preHandler: plannerAuth }, async (request, reply) => {
    if (!request.posUser) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Sign in required' },
      });
    }
    const provider = await buildProviderStatus(request.posUser.id);
    return reply.send({ providers: [provider] });
  });

  app.delete('/v1/integrations/google', { preHandler: auth }, async (_request, reply) => {
    const ownerId = await requireOwnerUserId(reply);
    if (!ownerId) return;
    await deps.tokenService.clearGoogleCalendar(ownerId);
    await deps.calendarPull.clearExternalCommitments(ownerId);
    clearSyncError(ownerId);
    return reply.send({ connected: false });
  });

  app.delete('/v2/integrations/google', { preHandler: plannerAuth }, async (request, reply) => {
    if (!request.posUser) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Sign in required' },
      });
    }
    const userId = request.posUser.id;
    await deps.tokenService.clearGoogleCalendar(userId);
    await deps.calendarPull.clearExternalCommitments(userId);
    clearSyncError(userId);
    // Disconnect Calendar only — do not revoke Personal OS session / logout.
    return reply.send({ connected: false });
  });

  app.get('/v1/calendar/events', { preHandler: auth }, async (request, reply) => {
    const ownerId = await requireOwnerUserId(reply);
    if (!ownerId) return;
    const q = request.query as { from?: string; to?: string };
    const fromEpochMs = q.from ? Date.parse(q.from) : Date.now() - 86_400_000;
    const toEpochMs = q.to ? Date.parse(q.to) : Date.now() + 14 * 86_400_000;
    const events = await deps.calendarPull.listStoredEvents(ownerId, fromEpochMs, toEpochMs);
    return reply.send({ events });
  });

  app.post('/v1/calendar/sync', { preHandler: auth }, async (_request, reply) => {
    const ownerId = await requireOwnerUserId(reply);
    if (!ownerId) return;
    return runCalendarSync(ownerId, reply);
  });

  app.post('/v2/calendar/sync', { preHandler: plannerAuth }, async (request, reply) => {
    if (!request.posUser) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Sign in required' },
      });
    }
    return runCalendarSync(request.posUser.id, reply);
  });
}
