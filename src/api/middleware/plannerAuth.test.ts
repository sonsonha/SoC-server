import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceService } from '../../application/deviceService.js';
import { createPlannerAuthHook } from './plannerAuth.js';

function replyStub() {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { reply: { code } as unknown as FastifyReply, code, send };
}

describe('planner auth', () => {
  it('accepts the private web bearer without invoking device auth', async () => {
    const deviceService = { authenticate: vi.fn() } as unknown as DeviceService;
    const hook = createPlannerAuthHook(deviceService, 'a'.repeat(32));
    const request = {
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
    } as FastifyRequest;
    const { reply, code } = replyStub();

    await hook(request, reply);

    expect(request.deviceId).toBe('personal-os-web');
    expect(code).not.toHaveBeenCalled();
    expect(deviceService.authenticate).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer token', async () => {
    const deviceService = { authenticate: vi.fn() } as unknown as DeviceService;
    const hook = createPlannerAuthHook(deviceService, 'a'.repeat(32));
    const request = {
      headers: { authorization: `Bearer ${'b'.repeat(32)}` },
    } as FastifyRequest;
    const { reply, code, send } = replyStub();

    await hook(request, reply);

    expect(code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith({
      error: { code: 'UNAUTHORIZED', message: 'Invalid planner credentials' },
    });
  });
});
