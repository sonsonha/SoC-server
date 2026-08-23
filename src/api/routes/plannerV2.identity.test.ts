import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceService } from '../../application/deviceService.js';
import type { PlannerV2Service } from '../../application/plannerV2Service.js';
import type { IdentityService } from '../../modules/identity/identityService.js';
import { plannerV2Routes } from './plannerV2.js';

describe('Planner V2 web identity gate', () => {
  it('blocks web bearer access without a Personal OS session', async () => {
    const app = Fastify();
    const identity = {
      resolveSession: vi.fn().mockResolvedValue(null),
      isAllowlisted: vi.fn().mockReturnValue(true),
    } as unknown as IdentityService;
    await plannerV2Routes(app, {
      planner: { getPlanner: vi.fn() } as unknown as PlannerV2Service,
      deviceService: {} as DeviceService,
      webToken: 'planner-test-token-32chars-minimum!!',
      identity,
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v2/planner?from=2026-08-17T00:00:00.000Z&to=2026-08-24T00:00:00.000Z',
      headers: { authorization: 'Bearer planner-test-token-32chars-minimum!!' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    await app.close();
  });

  it('blocks non-allowlisted sessions from the global planner', async () => {
    const app = Fastify();
    const identity = {
      resolveSession: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'stranger@example.com',
        name: 'Stranger',
        avatarUrl: null,
        googleSub: 'sub-1',
      }),
      isAllowlisted: vi.fn().mockReturnValue(false),
    } as unknown as IdentityService;
    await plannerV2Routes(app, {
      planner: { getPlanner: vi.fn() } as unknown as PlannerV2Service,
      deviceService: {} as DeviceService,
      webToken: 'planner-test-token-32chars-minimum!!',
      identity,
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v2/planner?from=2026-08-17T00:00:00.000Z&to=2026-08-24T00:00:00.000Z',
      headers: {
        authorization: 'Bearer planner-test-token-32chars-minimum!!',
        cookie: 'pos_session=opaque',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCOUNT_NOT_ENABLED');
    await app.close();
  });

  it('allows allowlisted session holders to load the planner', async () => {
    const getPlanner = vi.fn().mockResolvedValue({ tasks: [], projects: [], goals: [], timeBlocks: [], externalEvents: [] });
    const app = Fastify();
    const identity = {
      resolveSession: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'owner@example.com',
        name: 'Owner',
        avatarUrl: null,
        googleSub: 'sub-1',
      }),
      isAllowlisted: vi.fn().mockReturnValue(true),
    } as unknown as IdentityService;
    await plannerV2Routes(app, {
      planner: { getPlanner } as unknown as PlannerV2Service,
      deviceService: {} as DeviceService,
      webToken: 'planner-test-token-32chars-minimum!!',
      identity,
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v2/planner?from=2026-08-17T00:00:00.000Z&to=2026-08-24T00:00:00.000Z',
      headers: {
        authorization: 'Bearer planner-test-token-32chars-minimum!!',
        cookie: 'pos_session=opaque',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(getPlanner).toHaveBeenCalledWith(
      'user-1',
      '2026-08-17T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
    );
    await app.close();
  });
});
