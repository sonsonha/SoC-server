import { createHash, timingSafeEqual, verify } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceService } from '../../application/deviceService.js';
import { createDeviceAuthHook } from './deviceAuth.js';

const BEARER_AUTH = /^Bearer\s+(.+)$/i;
const WEB_KEY_ID = 'personal-os-web-v1';
const WEB_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyAzAZc1gBaYlwyaOcmjKTunJr1KOTVT0WH0kncIGpxA=
-----END PUBLIC KEY-----`;
const SIGNATURE_MAX_AGE_MS = 60_000;

function tokenMatches(candidate: string, expected: string): boolean {
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Planner V2 is shared by the phone and the private web workspace. Mobile keeps
 * the existing device credential while the web proxy signs short-lived requests.
 * The legacy bearer token is optional so local installations keep working.
 */
export function createPlannerAuthHook(
  deviceService: DeviceService,
  webToken?: string,
  webPublicKey: string = WEB_PUBLIC_KEY,
) {
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

    const keyId = request.headers['x-planner-key-id'];
    const timestamp = request.headers['x-planner-timestamp'];
    const signature = request.headers['x-planner-signature'];
    if (
      typeof keyId === 'string' &&
      typeof timestamp === 'string' &&
      typeof signature === 'string'
    ) {
      const signedAt = Number(timestamp);
      const fresh = Number.isFinite(signedAt) && Math.abs(Date.now() - signedAt) <= SIGNATURE_MAX_AGE_MS;
      const message = `${timestamp}\n${request.method.toUpperCase()}\n${request.url}`;
      let signatureValid = false;
      try {
        signatureValid = keyId === WEB_KEY_ID && fresh && verify(
          null,
          Buffer.from(message),
          webPublicKey,
          Buffer.from(signature, 'base64url'),
        );
      } catch {
        signatureValid = false;
      }
      if (signatureValid) {
        request.deviceId = 'personal-os-web';
        return;
      }
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid planner signature' },
      });
    }

    if (bearer) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid planner credentials' },
      });
    }

    return deviceAuth(request, reply);
  };
}
