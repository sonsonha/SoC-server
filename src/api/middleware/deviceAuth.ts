import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceService } from '../../application/deviceService.js';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId?: string;
  }
}

const DEVICE_AUTH = /^Device\s+([^:]+):(.+)$/i;

export function createDeviceAuthHook(deviceService: DeviceService) {
  return async function deviceAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' },
      });
    }
    const match = DEVICE_AUTH.exec(header);
    if (!match) {
      return reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Expected Authorization: Device <deviceId>:<secret>',
        },
      });
    }
    const [, deviceId, secret] = match;
    const ok = await deviceService.authenticate(deviceId, secret);
    if (!ok) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid device credentials' },
      });
    }
    request.deviceId = deviceId;
  };
}
