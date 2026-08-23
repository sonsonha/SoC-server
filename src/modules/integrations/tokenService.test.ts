import { describe, expect, it, vi } from 'vitest';
import { IntegrationTokenService } from './tokenService.js';

vi.mock('../../infrastructure/crypto/tokenEncryption.js', () => ({
  encryptSecret: (plaintext: string) => `enc:${plaintext}`,
  decryptSecret: (payload: string) => payload.replace(/^enc:/, ''),
}));

function makeDb(rows: Array<Record<string, unknown>>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          Object.assign(rows[0]!, values);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        void table;
        rows.push({ ...values });
      },
    }),
    delete: () => ({ where: async () => undefined }),
  };
}

describe('IntegrationTokenService refresh token persistence', () => {
  it('preserves existing refresh token when Google omits refresh_token on reconnect', async () => {
    const rows = [{
      id: 'tok-1',
      userId: 'user-a',
      provider: 'google_calendar',
      accessTokenEnc: 'enc:old-access',
      refreshTokenEnc: 'enc:keep-refresh',
      expiresAt: new Date(Date.now() - 60_000),
      scopes: 'openid email',
      googleAccountSub: 'sub-a',
      googleAccountEmail: 'a@example.com',
      writeCalendarId: 'cal-1',
      status: 'connected',
      lastErrorCode: null,
      lastSyncAt: null,
      updatedAt: new Date(),
    }];
    const service = new IntegrationTokenService(makeDb(rows) as never, 'test-encryption-key');
    const result = await service.saveGoogleCalendarTokens('user-a', {
      accessToken: 'new-access',
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: 'openid email https://www.googleapis.com/auth/calendar.events',
      googleAccountSub: 'sub-a',
      googleAccountEmail: 'a@example.com',
    });
    expect(result.preservedRefreshToken).toBe(true);
    expect(result.hasRefreshToken).toBe(true);
    expect(rows[0]!.refreshTokenEnc).toBe('enc:keep-refresh');
    expect(rows[0]!.accessTokenEnc).toBe('enc:new-access');
  });

  it('stores refresh token on initial connect', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const service = new IntegrationTokenService(makeDb(rows) as never, 'test-encryption-key');
    const result = await service.saveGoogleCalendarTokens('user-b', {
      accessToken: 'access',
      refreshToken: 'fresh-refresh',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: 'openid email',
      googleAccountSub: 'sub-b',
      googleAccountEmail: 'b@example.com',
    });
    expect(result.preservedRefreshToken).toBe(false);
    expect(result.hasRefreshToken).toBe(true);
    expect(rows[0]!.refreshTokenEnc).toBe('enc:fresh-refresh');
  });

  it('marks reconnectRequired when connected without refresh token', async () => {
    const rows = [{
      id: 'tok-1',
      userId: 'user-a',
      provider: 'google_calendar',
      accessTokenEnc: 'enc:access',
      refreshTokenEnc: null,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: 'openid email',
      googleAccountSub: 'sub-a',
      googleAccountEmail: 'a@example.com',
      writeCalendarId: null,
      status: 'connected',
      lastErrorCode: null,
      lastSyncAt: null,
      updatedAt: new Date(),
    }];
    const service = new IntegrationTokenService(makeDb(rows) as never, 'test-encryption-key');
    const status = await service.getPublicStatus('user-a');
    expect(status.connected).toBe(true);
    expect(status.reconnectRequired).toBe(true);
    expect(status.healthy).toBe(false);
  });

  it('does not treat GOOGLE_FORBIDDEN lastError as reconnectRequired', async () => {
    const rows = [{
      id: 'tok-1',
      userId: 'user-a',
      provider: 'google_calendar',
      accessTokenEnc: 'enc:access',
      refreshTokenEnc: 'enc:refresh',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: 'openid email',
      googleAccountSub: 'sub-a',
      googleAccountEmail: 'a@example.com',
      writeCalendarId: 'cal-1',
      status: 'connected',
      lastErrorCode: 'GOOGLE_FORBIDDEN',
      lastSyncAt: null,
      updatedAt: new Date(),
    }];
    const service = new IntegrationTokenService(makeDb(rows) as never, 'test-encryption-key');
    const status = await service.getPublicStatus('user-a');
    expect(status.connected).toBe(true);
    expect(status.reconnectRequired).toBe(false);
    expect(status.healthy).toBe(false);
    expect(status.lastErrorCode).toBe('GOOGLE_FORBIDDEN');
  });
});

describe('IntegrationTokenService.refreshGoogleAccessToken', () => {
  it('returns null on revoked refresh token instead of reusing the expired access token', async () => {
    const rows = [{
      id: 'tok-1',
      userId: 'user-a',
      provider: 'google_calendar',
      accessTokenEnc: 'enc:access',
      refreshTokenEnc: 'enc:refresh',
      expiresAt: new Date(Date.now() - 60_000),
      scopes: 'https://www.googleapis.com/auth/calendar.events',
      googleAccountSub: 'sub-a',
      googleAccountEmail: 'a@example.com',
      writeCalendarId: null,
      status: 'connected',
      lastErrorCode: null,
      lastSyncAt: null,
      updatedAt: new Date(),
    }];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
      insert: async () => undefined,
      delete: () => ({ where: async () => undefined }),
    };

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ) as typeof fetch;

    const service = new IntegrationTokenService(db as never, 'test-encryption-key');
    const result = await service.refreshGoogleAccessToken('user-a', {
      clientId: 'client',
      clientSecret: 'secret',
    });
    expect(result).toBeNull();
  });
});
