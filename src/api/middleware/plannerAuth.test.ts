import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { generateKeyPairSync, sign } from 'node:crypto';
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

  it('accepts a fresh request signed by the private web key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const timestamp = String(Date.now());
    const method = 'GET';
    const url = '/v2/planner?from=2026-08-10&to=2026-08-17';
    const signature = sign(
      null,
      Buffer.from(`${timestamp}\n${method}\n${url}`),
      privateKey,
    ).toString('base64url');
    const deviceService = { authenticate: vi.fn() } as unknown as DeviceService;
    const hook = createPlannerAuthHook(deviceService, undefined, publicPem);
    const request = {
      method,
      url,
      headers: {
        'x-planner-key-id': 'personal-os-web-v1',
        'x-planner-timestamp': timestamp,
        'x-planner-signature': signature,
      },
    } as unknown as FastifyRequest;
    const { reply, code } = replyStub();

    await hook(request, reply);

    expect(request.deviceId).toBe('personal-os-web');
    expect(code).not.toHaveBeenCalled();
  });

  it('rejects stale signed requests', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const timestamp = String(Date.now() - 120_000);
    const method = 'GET';
    const url = '/v2/planner';
    const signature = sign(
      null,
      Buffer.from(`${timestamp}\n${method}\n${url}`),
      privateKey,
    ).toString('base64url');
    const hook = createPlannerAuthHook(
      { authenticate: vi.fn() } as unknown as DeviceService,
      undefined,
      publicPem,
    );
    const request = {
      method,
      url,
      headers: {
        'x-planner-key-id': 'personal-os-web-v1',
        'x-planner-timestamp': timestamp,
        'x-planner-signature': signature,
      },
    } as unknown as FastifyRequest;
    const { reply, code } = replyStub();

    await hook(request, reply);

    expect(code).toHaveBeenCalledWith(401);
  });
});
