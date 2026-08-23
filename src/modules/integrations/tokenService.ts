import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { integrationTokens } from '../../infrastructure/db/schema/index.js';
import { decryptSecret, encryptSecret } from '../../infrastructure/crypto/tokenEncryption.js';

export const GOOGLE_CALENDAR_PROVIDER = 'google_calendar';

export type StoredTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  googleAccountSub: string | null;
  googleAccountEmail: string | null;
  writeCalendarId: string | null;
  status: string;
  lastErrorCode: string | null;
  lastSyncAt: Date | null;
};

export type IntegrationPublicStatus = {
  connected: boolean;
  healthy: boolean;
  reconnectRequired: boolean;
  mode: 'fake' | 'live' | 'none';
  googleAccountEmail: string | null;
  writeCalendarId: string | null;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
};

export class IntegrationTokenService {
  constructor(
    private readonly db: Db,
    private readonly encryptionKey: string,
  ) {}

  private toStored(row: typeof integrationTokens.$inferSelect): StoredTokens {
    return {
      accessToken: decryptSecret(row.accessTokenEnc, this.encryptionKey),
      refreshToken: row.refreshTokenEnc
        ? decryptSecret(row.refreshTokenEnc, this.encryptionKey)
        : null,
      expiresAt: row.expiresAt,
      scopes: row.scopes,
      googleAccountSub: row.googleAccountSub,
      googleAccountEmail: row.googleAccountEmail,
      writeCalendarId: row.writeCalendarId,
      status: row.status,
      lastErrorCode: row.lastErrorCode,
      lastSyncAt: row.lastSyncAt,
    };
  }

  async getGoogleCalendarTokens(userId: string): Promise<StoredTokens | null> {
    const rows = await this.db
      .select()
      .from(integrationTokens)
      .where(
        and(
          eq(integrationTokens.userId, userId),
          eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.toStored(row);
  }

  /**
   * Legacy singleton left by incomplete Batch C backfill (`user_id` NULL).
   * Only when exactly one such row exists.
   */
  async getOrphanGoogleCalendarTokens(): Promise<StoredTokens | null> {
    const rows = await this.db
      .select()
      .from(integrationTokens)
      .where(
        and(
          isNull(integrationTokens.userId),
          eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER),
        ),
      )
      .limit(2);
    if (rows.length !== 1 || !rows[0]) return null;
    return this.toStored(rows[0]);
  }

  async saveGoogleCalendarTokens(
    userId: string,
    input: {
      accessToken: string;
      /** When omitted/null and a row exists, the previous refresh token is preserved. */
      refreshToken?: string | null;
      expiresAt?: Date | null;
      scopes?: string | null;
      googleAccountSub: string;
      googleAccountEmail: string;
      writeCalendarId?: string | null;
      status?: string;
      lastErrorCode?: string | null;
    },
  ): Promise<{
    preservedRefreshToken: boolean;
    hasRefreshToken: boolean;
    claimedOrphan: boolean;
  }> {
    const existing = await this.db
      .select()
      .from(integrationTokens)
      .where(
        and(
          eq(integrationTokens.userId, userId),
          eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER),
        ),
      )
      .limit(1);
    const now = new Date();
    const incomingRefresh = input.refreshToken?.trim() || null;

    let target = existing[0];
    let claimedOrphan = false;
    if (!target) {
      const orphans = await this.db
        .select()
        .from(integrationTokens)
        .where(
          and(
            isNull(integrationTokens.userId),
            eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER),
          ),
        )
        .limit(2);
      if (orphans.length === 1 && orphans[0]) {
        target = orphans[0];
        claimedOrphan = true;
      }
    }

    if (target) {
      const preserved = !incomingRefresh && Boolean(target.refreshTokenEnc);
      await this.db
        .update(integrationTokens)
        .set({
          userId,
          accessTokenEnc: encryptSecret(input.accessToken, this.encryptionKey),
          // Never wipe a stored refresh token when Google omits refresh_token on re-consent.
          refreshTokenEnc: incomingRefresh
            ? encryptSecret(incomingRefresh, this.encryptionKey)
            : target.refreshTokenEnc,
          expiresAt: input.expiresAt ?? target.expiresAt,
          scopes: input.scopes ?? target.scopes,
          googleAccountSub: input.googleAccountSub,
          googleAccountEmail: input.googleAccountEmail,
          writeCalendarId: input.writeCalendarId === undefined
            ? target.writeCalendarId
            : input.writeCalendarId,
          status: input.status ?? 'connected',
          lastErrorCode: input.lastErrorCode === undefined ? null : input.lastErrorCode,
          updatedAt: now,
        })
        .where(eq(integrationTokens.id, target.id));
      return {
        preservedRefreshToken: preserved,
        hasRefreshToken: Boolean(incomingRefresh || target.refreshTokenEnc),
        claimedOrphan,
      };
    }

    await this.db.insert(integrationTokens).values({
      id: randomUUID(),
      userId,
      provider: GOOGLE_CALENDAR_PROVIDER,
      accessTokenEnc: encryptSecret(input.accessToken, this.encryptionKey),
      refreshTokenEnc: incomingRefresh
        ? encryptSecret(incomingRefresh, this.encryptionKey)
        : null,
      expiresAt: input.expiresAt ?? null,
      scopes: input.scopes ?? null,
      googleAccountSub: input.googleAccountSub,
      googleAccountEmail: input.googleAccountEmail,
      writeCalendarId: input.writeCalendarId ?? null,
      status: input.status ?? 'connected',
      lastErrorCode: input.lastErrorCode ?? null,
      updatedAt: now,
    });
    return {
      preservedRefreshToken: false,
      hasRefreshToken: Boolean(incomingRefresh),
      claimedOrphan: false,
    };
  }

  async setWriteCalendarId(userId: string, writeCalendarId: string): Promise<void> {
    await this.db
      .update(integrationTokens)
      .set({ writeCalendarId, updatedAt: new Date() })
      .where(
        and(
          eq(integrationTokens.userId, userId),
          eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER),
        ),
      );
  }

  async markReconnectRequired(userId: string, errorCode: string): Promise<void> {
    await this.db
      .update(integrationTokens)
      .set({
        status: 'reconnect_required',
        lastErrorCode: errorCode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationTokens.userId, userId),
          eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER),
        ),
      );
  }

  async touchLastSync(userId: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(integrationTokens)
      .set({ lastSyncAt: at, lastErrorCode: null, status: 'connected', updatedAt: at })
      .where(
        and(
          eq(integrationTokens.userId, userId),
          eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER),
        ),
      );
  }

  async clearGoogleCalendar(userId: string): Promise<void> {
    await this.db
      .delete(integrationTokens)
      .where(
        and(
          eq(integrationTokens.userId, userId),
          eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER),
        ),
      );
  }

  async isGoogleCalendarConnected(userId: string): Promise<boolean> {
    const tokens = await this.getGoogleCalendarTokens(userId);
    return Boolean(tokens) && tokens!.accessToken !== 'fake-access-token';
  }

  async listConnectedUserIds(): Promise<string[]> {
    const rows = await this.db
      .select({ userId: integrationTokens.userId })
      .from(integrationTokens)
      .where(eq(integrationTokens.provider, GOOGLE_CALENDAR_PROVIDER));
    return rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
  }

  async getPublicStatus(userId: string, opts?: { useFakeProviders?: boolean }): Promise<IntegrationPublicStatus> {
    const tokens = await this.getGoogleCalendarTokens(userId);
    const isFake = tokens?.accessToken === 'fake-access-token';
    const connected = Boolean(tokens) && !isFake;
    // Missing refresh token or explicit reconnect status → must re-consent.
    // GOOGLE_FORBIDDEN is a permission problem — not an OAuth reconnect loop trigger.
    const reconnectRequired = tokens?.status === 'reconnect_required'
      || tokens?.lastErrorCode === 'GOOGLE_RECONNECT_REQUIRED'
      || Boolean(connected && !tokens?.refreshToken);
    const mode = opts?.useFakeProviders || isFake
      ? 'fake'
      : connected
        ? 'live'
        : 'none';
    return {
      connected: connected || Boolean(opts?.useFakeProviders && tokens),
      healthy: connected && !reconnectRequired && !tokens?.lastErrorCode,
      reconnectRequired,
      mode,
      googleAccountEmail: tokens?.googleAccountEmail ?? null,
      writeCalendarId: tokens?.writeCalendarId ?? null,
      lastSyncAt: tokens?.lastSyncAt?.toISOString() ?? null,
      lastErrorCode: tokens?.lastErrorCode ?? null,
    };
  }

  async refreshGoogleAccessToken(
    userId: string,
    config: { clientId?: string; clientSecret?: string },
  ): Promise<StoredTokens | null> {
    const current = await this.getGoogleCalendarTokens(userId);
    if (!current) return null;
    if (!current.refreshToken || !config.clientId || !config.clientSecret) {
      console.error('google.tokenRefresh skipped', {
        userId,
        hasRefreshToken: Boolean(current.refreshToken),
        hasClientId: Boolean(config.clientId),
        hasClientSecret: Boolean(config.clientSecret),
      });
      return null;
    }
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
    if (!res.ok) {
      const detail = await res.text();
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(detail) as { error?: string };
        reason = typeof parsed.error === 'string' ? parsed.error : undefined;
      } catch {
        reason = undefined;
      }
      console.error('google.tokenRefresh failed', {
        userId,
        googleStatus: res.status,
        reason: reason ?? null,
      });
      if (res.status === 400 || res.status === 401) {
        await this.markReconnectRequired(userId, 'GOOGLE_RECONNECT_REQUIRED');
        return null;
      }
      return current;
    }
    const tokens = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      scope?: string;
    };
    await this.saveGoogleCalendarTokens(userId, {
      accessToken: tokens.access_token,
      refreshToken: current.refreshToken,
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null,
      scopes: tokens.scope ?? current.scopes,
      googleAccountSub: current.googleAccountSub ?? 'unknown',
      googleAccountEmail: current.googleAccountEmail ?? 'unknown',
      writeCalendarId: current.writeCalendarId,
      status: 'connected',
      lastErrorCode: null,
    });
    return this.getGoogleCalendarTokens(userId);
  }
}

export function hashOAuthState(rawState: string): string {
  return createHash('sha256').update(rawState).digest('hex');
}

export function generateOAuthStateToken(): string {
  return randomBytes(32).toString('base64url');
}
