import { describe, expect, it, vi } from 'vitest';
import { IntegrationTokenService } from './tokenService.js';

describe('IntegrationTokenService.refreshGoogleAccessToken', () => {
  it('returns null on revoked refresh token instead of reusing the expired access token', async () => {
    const rows = [{
      id: 'tok-1',
      provider: 'google_calendar',
      accessTokenEnc: 'enc-access',
      refreshTokenEnc: 'enc-refresh',
      expiresAt: new Date(Date.now() - 60_000),
      scopes: 'https://www.googleapis.com/auth/calendar.events',
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

    vi.spyOn(await import('../../infrastructure/crypto/tokenEncryption.js'), 'decryptSecret')
      .mockImplementation((payload: string) => (payload === 'enc-refresh' ? 'refresh-token' : 'access-token'));
    vi.spyOn(await import('../../infrastructure/crypto/tokenEncryption.js'), 'encryptSecret')
      .mockImplementation((plaintext: string) => `enc:${plaintext}`);

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ) as typeof fetch;

    const service = new IntegrationTokenService(db as never, 'test-encryption-key');
    const result = await service.refreshGoogleAccessToken({
      clientId: 'client',
      clientSecret: 'secret',
    });
    expect(result).toBeNull();
  });
});
