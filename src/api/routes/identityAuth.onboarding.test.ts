import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceService } from '../../application/deviceService.js';
import type { AppConfig } from '../../config.js';
import type { IdentityService } from '../../modules/identity/identityService.js';
import { identityAuthRoutes } from './identityAuth.js';

const webToken = 'planner-test-token-32chars-minimum!!';

function mockConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    GOOGLE_IDENTITY_CLIENT_ID: 'identity-client.apps.googleusercontent.com',
    PLANNER_WEB_TOKEN: webToken,
  } as AppConfig;
}

describe('identity auth onboarding', () => {
  it('exposes onboardingCompletedAt on /me', async () => {
    const app = Fastify();
    const identity = {
      resolveSession: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'owner@example.com',
        name: 'Owner',
        avatarUrl: null,
        googleSub: 'sub-1',
        onboardingCompletedAt: null,
      }),
      isAllowlisted: vi.fn().mockReturnValue(true),
    } as unknown as IdentityService;

    await identityAuthRoutes(app, {
      deviceService: {} as DeviceService,
      config: mockConfig(),
      identity,
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v2/auth/me',
      headers: {
        authorization: `Bearer ${webToken}`,
        cookie: 'pos_session=opaque',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.onboardingCompletedAt).toBeNull();
    await app.close();
  });

  it('marks onboarding complete via POST /onboarding/complete', async () => {
    const app = Fastify();
    const completedAt = '2026-08-23T05:00:00.000Z';
    const identity = {
      resolveSession: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'newbie@example.com',
        name: 'Newbie',
        avatarUrl: null,
        googleSub: 'sub-2',
        onboardingCompletedAt: null,
      }),
      isAllowlisted: vi.fn().mockReturnValue(true),
      markOnboardingCompleted: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'newbie@example.com',
        name: 'Newbie',
        avatarUrl: null,
        onboardingCompletedAt: completedAt,
      }),
    } as unknown as IdentityService;

    await identityAuthRoutes(app, {
      deviceService: {} as DeviceService,
      config: mockConfig(),
      identity,
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/auth/onboarding/complete',
      headers: {
        authorization: `Bearer ${webToken}`,
        cookie: 'pos_session=opaque',
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(identity.markOnboardingCompleted).toHaveBeenCalledWith('user-1');
    expect(response.json().user.onboardingCompletedAt).toBe(completedAt);
    await app.close();
  });

  it('returns ACCOUNT_NOT_ENABLED without exposing planner data semantics', async () => {
    const app = Fastify();
    const identity = {
      resolveSession: vi.fn().mockResolvedValue({
        id: 'user-x',
        email: 'blocked@example.com',
        name: 'Blocked',
        avatarUrl: null,
        googleSub: 'sub-x',
        onboardingCompletedAt: null,
      }),
      isAllowlisted: vi.fn().mockReturnValue(false),
    } as unknown as IdentityService;

    await identityAuthRoutes(app, {
      deviceService: {} as DeviceService,
      config: mockConfig(),
      identity,
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v2/auth/me',
      headers: {
        authorization: `Bearer ${webToken}`,
        cookie: 'pos_session=opaque',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCOUNT_NOT_ENABLED');
    await app.close();
  });
});
