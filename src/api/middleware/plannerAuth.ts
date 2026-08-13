import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceService } from '../../application/deviceService.js';
import { createDeviceAuthHook } from './deviceAuth.js';

const BEARER_AUTH = /^Bearer\s+(.+)$/i;

function tokenMatches(candidate: string, expected: string): boolean {
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Planner V2 is shared by the phone and the private web workspace. Mobile keeps
 * the existing device credential while the web proxy uses a server-only bearer
 * token. The bearer token is optional so existing installations keep working.
 */
export function createPlannerAuthHook(deviceService: DeviceService, webToken?: string) {
  const deviceAuth = createDeviceAuthHook(deviceService);

  return async function plannerAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    const bearer = header ? BEARER_AUTH.exec(header) : null;
    if (webToken && bearer && tokenMatches(bearer[1], webToken)) {
      request.deviceId = 'personal-os-web';
      return;
    }

    if (bearer) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid planner credentials' },
      });
    }

    return deviceAuth(request, reply);
  };
}
