import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityService, SessionUser } from '../../modules/identity/identityService.js';
import { readSessionTokenFromCookieHeader } from '../../modules/identity/identityService.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Personal OS identity — separate from deviceId / Calendar OAuth. */
    posUser?: SessionUser;
  }
}

/**
 * Requires a valid Personal OS session cookie + allowlisted email for the web proxy.
 *
 * Mobile / device credentials (deviceId !== personal-os-web):
 * Batch B maps them to the explicit initial owner only (owner-scoped data).
 * If PERSONAL_OS_INITIAL_OWNER_EMAIL is unset or the user row is missing → 403.
 * This prevents the Batch A bypass from reading all users' planner data.
 */
export function createPersonalOsUserHook(identity: IdentityService) {
  return async function requirePersonalOsUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (request.deviceId && request.deviceId !== 'personal-os-web') {
      const owner = await identity.resolveInitialOwnerUser();
      if (!owner) {
        return reply.code(403).send({
          error: {
            code: 'DEVICE_PLANNER_OWNER_REQUIRED',
            message:
              'Device planner access requires PERSONAL_OS_INITIAL_OWNER_EMAIL and a matching users row',
          },
        });
      }
      request.posUser = owner;
      return;
    }
    const rawToken = readSessionTokenFromCookieHeader(request.headers.cookie);
    const user = await identity.resolveSession(rawToken);
    if (!user) {
      return reply.code(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Sign in with Google to continue',
        },
      });
    }
    if (!identity.isAllowlisted(user.email)) {
      return reply.code(403).send({
        error: {
          code: 'ACCOUNT_NOT_ENABLED',
          message: 'This account is not enabled yet',
        },
      });
    }
    request.posUser = user;
  };
}
