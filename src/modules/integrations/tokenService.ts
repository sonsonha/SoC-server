import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { integrationTokens } from '../../infrastructure/db/schema/index.js';
import { decryptSecret, encryptSecret } from '../../infrastructure/crypto/tokenEncryption.js';

const GOOGLE_CALENDAR = 'google_calendar';

export type StoredTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
};

export class IntegrationTokenService {
  constructor(
    private readonly db: Db,
    private readonly encryptionKey: string,
  ) {}

  async getGoogleCalendarTokens(): Promise<StoredTokens | null> {
    const rows = await this.db
      .select()
      .from(integrationTokens)
      .where(eq(integrationTokens.provider, GOOGLE_CALENDAR))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      accessToken: decryptSecret(row.accessTokenEnc, this.encryptionKey),
      refreshToken: row.refreshTokenEnc
        ? decryptSecret(row.refreshTokenEnc, this.encryptionKey)
        : null,
      expiresAt: row.expiresAt,
      scopes: row.scopes,
    };
  }

  async saveGoogleCalendarTokens(input: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    scopes?: string | null;
  }): Promise<void> {
    const existing = await this.db
      .select()
      .from(integrationTokens)
      .where(eq(integrationTokens.provider, GOOGLE_CALENDAR))
      .limit(1);
    const now = new Date();
    if (existing[0]) {
      await this.db
        .update(integrationTokens)
        .set({
          accessTokenEnc: encryptSecret(input.accessToken, this.encryptionKey),
          refreshTokenEnc: input.refreshToken
            ? encryptSecret(input.refreshToken, this.encryptionKey)
            : existing[0].refreshTokenEnc,
          expiresAt: input.expiresAt ?? existing[0].expiresAt,
          scopes: input.scopes ?? existing[0].scopes,
          updatedAt: now,
        })
        .where(eq(integrationTokens.id, existing[0].id));
      return;
    }
    await this.db.insert(integrationTokens).values({
      id: randomUUID(),
      provider: GOOGLE_CALENDAR,
      accessTokenEnc: encryptSecret(input.accessToken, this.encryptionKey),
      refreshTokenEnc: input.refreshToken
        ? encryptSecret(input.refreshToken, this.encryptionKey)
        : null,
      expiresAt: input.expiresAt ?? null,
      scopes: input.scopes ?? null,
      updatedAt: now,
    });
  }

  async clearGoogleCalendar(): Promise<void> {
    await this.db.delete(integrationTokens).where(eq(integrationTokens.provider, GOOGLE_CALENDAR));
  }

  async isGoogleCalendarConnected(): Promise<boolean> {
    const rows = await this.db
      .select({ id: integrationTokens.id })
      .from(integrationTokens)
      .where(eq(integrationTokens.provider, GOOGLE_CALENDAR))
      .limit(1);
    return rows.length > 0;
  }

  async refreshGoogleAccessToken(config: {
    clientId?: string;
    clientSecret?: string;
  }): Promise<StoredTokens | null> {
    const current = await this.getGoogleCalendarTokens();
    if (!current?.refreshToken || !config.clientId || !config.clientSecret) return current;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: current.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) return current;
    const tokens = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      scope?: string;
    };
    await this.saveGoogleCalendarTokens({
      accessToken: tokens.access_token,
      refreshToken: current.refreshToken,
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null,
      scopes: tokens.scope ?? current.scopes,
    });
    return this.getGoogleCalendarTokens();
  }
}
