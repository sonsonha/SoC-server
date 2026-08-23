import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DeviceService } from '../../application/deviceService.js';
import { createPlannerAuthHook } from '../middleware/plannerAuth.js';
import { verifyGoogleIdToken } from '../../modules/identity/googleIdToken.js';
import {
  buildSessionCookie,
  clearSessionCookie,
  readSessionTokenFromCookieHeader,
  type IdentityService,
} from '../../modules/identity/identityService.js';

const googleLoginBody = z.object({
  idToken: z.string().min(20).max(8_000),
});

export async function identityAuthRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    config: AppConfig;
    identity: IdentityService;
  },
) {
  const serviceAuth = createPlannerAuthHook(
    deps.deviceService,
    deps.config.PLANNER_WEB_TOKEN,
  );
  const secureCookie = deps.config.NODE_ENV === 'production';
  const audience =
    deps.config.GOOGLE_IDENTITY_CLIENT_ID
    ?? deps.config.GOOGLE_OAUTH_CLIENT_ID;

  const publicConfig = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      googleClientId: audience ?? null,
      identityEnabled: Boolean(audience),
    });
  };

  app.get('/v1/auth/config', { preHandler: serviceAuth }, publicConfig);
  app.get('/v2/auth/config', { preHandler: serviceAuth }, publicConfig);

  const googleLogin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!audience) {
      return reply.code(503).send({
        error: {
          code: 'IDENTITY_NOT_CONFIGURED',
          message: 'Google identity client ID is not configured',
        },
      });
    }
    const body = googleLoginBody.parse(request.body ?? {});
    let identity;
    try {
      identity = await verifyGoogleIdToken(body.idToken, audience);
    } catch (err) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 401).send({
        error: {
          code: error.code ?? 'INVALID_GOOGLE_TOKEN',
          message: error.message ?? 'Invalid Google identity token',
        },
      });
    }

    const user = await deps.identity.upsertGoogleUser(identity);
    if (!deps.identity.isAllowlisted(user.email)) {
      return reply.code(403).send({
        error: {
          code: 'ACCOUNT_NOT_ENABLED',
          message: 'This account is not enabled yet',
        },
      });
    }

    const session = await deps.identity.createSession(user.id);
    reply.header(
      'set-cookie',
      buildSessionCookie(session.rawToken, session.expiresAt, { secure: secureCookie }),
    );
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        onboardingCompletedAt: user.onboardingCompletedAt,
      },
    });
  };

  app.post('/v1/auth/google', { preHandler: serviceAuth }, googleLogin);
  app.post('/v2/auth/google', { preHandler: serviceAuth }, googleLogin);

  const me = async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = readSessionTokenFromCookieHeader(request.headers.cookie);
    const user = await deps.identity.resolveSession(rawToken);
    if (!user) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in with Google to continue' },
      });
    }
    if (!deps.identity.isAllowlisted(user.email)) {
      return reply.code(403).send({
        error: {
          code: 'ACCOUNT_NOT_ENABLED',
          message: 'This account is not enabled yet',
        },
      });
    }
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        onboardingCompletedAt: user.onboardingCompletedAt,
      },
    });
  };

  app.get('/v1/auth/me', { preHandler: serviceAuth }, me);
  app.get('/v2/auth/me', { preHandler: serviceAuth }, me);

  const completeOnboarding = async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = readSessionTokenFromCookieHeader(request.headers.cookie);
    const user = await deps.identity.resolveSession(rawToken);
    if (!user) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in with Google to continue' },
      });
    }
    if (!deps.identity.isAllowlisted(user.email)) {
      return reply.code(403).send({
        error: {
          code: 'ACCOUNT_NOT_ENABLED',
          message: 'This account is not enabled yet',
        },
      });
    }
    const updated = await deps.identity.markOnboardingCompleted(user.id);
    return reply.send({
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        avatarUrl: updated.avatarUrl,
        onboardingCompletedAt: updated.onboardingCompletedAt,
      },
    });
  };

  app.post('/v1/auth/onboarding/complete', { preHandler: serviceAuth }, completeOnboarding);
  app.post('/v2/auth/onboarding/complete', { preHandler: serviceAuth }, completeOnboarding);

  const logout = async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = readSessionTokenFromCookieHeader(request.headers.cookie);
    await deps.identity.revokeSession(rawToken);
    reply.header('set-cookie', clearSessionCookie({ secure: secureCookie }));
    return reply.send({ ok: true });
  };

  app.post('/v1/auth/logout', { preHandler: serviceAuth }, logout);
  app.post('/v2/auth/logout', { preHandler: serviceAuth }, logout);
}
