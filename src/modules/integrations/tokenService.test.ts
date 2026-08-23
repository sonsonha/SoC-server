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

  it('claims legacy orphan NULL user_id row on save when allowOrphanClaim', async () => {
    const rows: Array<Record<string, unknown>> = [{
      id: 'orphan-1',
      userId: null,
      provider: 'google_calendar',
      accessTokenEnc: 'enc:old-access',
      refreshTokenEnc: 'enc:orphan-refresh',
      expiresAt: new Date(Date.now() - 60_000),
      scopes: 'openid email',
      googleAccountSub: null,
      googleAccountEmail: null,
      writeCalendarId: null,
      status: 'connected',
      lastErrorCode: null,
      lastSyncAt: null,
      updatedAt: new Date(),
    }];
    let selectCalls = 0;

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async (n: number) => {
              selectCalls += 1;
              // 1st: getOrphan in test; 2nd: user-scoped in save; 3rd: orphan claim in save
              if (selectCalls === 2) return [];
              return rows.filter((r) => r.userId == null).slice(0, n);
            },
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
      insert: () => ({
        values: async () => {
          throw new Error('insert should not run when claiming orphan');
        },
      }),
      delete: () => ({ where: async () => undefined }),
    };

    const service = new IntegrationTokenService(db as never, 'test-encryption-key');
    const orphan = await service.getOrphanGoogleCalendarTokens();
    expect(orphan?.refreshToken).toBe('orphan-refresh');

    const result = await service.saveGoogleCalendarTokens(
      'user-owner',
      {
        accessToken: 'new-access',
        refreshToken: null,
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: 'calendar',
        googleAccountSub: 'sub-owner',
        googleAccountEmail: 'owner@example.com',
      },
      { allowOrphanClaim: true },
    );
    expect(result.claimedOrphan).toBe(true);
    expect(result.preservedRefreshToken).toBe(true);
    expect(result.hasRefreshToken).toBe(true);
    expect(rows[0]!.userId).toBe('user-owner');
    expect(rows[0]!.refreshTokenEnc).toBe('enc:orphan-refresh');
    expect(rows[0]!.googleAccountEmail).toBe('owner@example.com');
  });

  it('does not claim orphan for second user without allowOrphanClaim — inserts new row', async () => {
    const orphanRow = {
      id: 'orphan-1',
      userId: null as string | null,
      provider: 'google_calendar',
      accessTokenEnc: 'enc:owner-access',
      refreshTokenEnc: 'enc:owner-refresh',
      expiresAt: new Date(Date.now() - 60_000),
      scopes: 'openid email',
      googleAccountSub: 'sub-owner',
      googleAccountEmail: 'owner@example.com',
      writeCalendarId: 'owner-cal',
      status: 'connected',
      lastErrorCode: null,
      lastSyncAt: null,
      updatedAt: new Date(),
    };
    const rows: Array<Record<string, unknown>> = [orphanRow];
    let selectCalls = 0;

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCalls += 1;
              // User B has no row; orphan lookup must not run without allowOrphanClaim
              if (selectCalls === 1) return [];
              return [orphanRow];
            },
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            throw new Error('update should not run for User B first connect');
          },
        }),
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          rows.push({ ...values });
        },
      }),
      delete: () => ({ where: async () => undefined }),
    };

    const service = new IntegrationTokenService(db as never, 'test-encryption-key');
    const result = await service.saveGoogleCalendarTokens('user-b', {
      accessToken: 'b-access',
      refreshToken: 'b-refresh',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: 'calendar',
      googleAccountSub: 'sub-b',
      googleAccountEmail: 'terryson821@gmail.com',
    });
    expect(result.claimedOrphan).toBe(false);
    expect(result.hasRefreshToken).toBe(true);
    expect(orphanRow.userId).toBeNull();
    expect(orphanRow.refreshTokenEnc).toBe('enc:owner-refresh');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.userId).toBe('user-b');
    expect(rows[1]!.refreshTokenEnc).toBe('enc:b-refresh');
    expect(rows[1]!.googleAccountEmail).toBe('terryson821@gmail.com');
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
    expect(result.claimedOrphan).toBe(false);
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
