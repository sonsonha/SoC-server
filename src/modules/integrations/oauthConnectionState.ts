import { and, eq, isNull, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { oauthConnectionStates } from '../../infrastructure/db/schema/index.js';
import { generateOAuthStateToken, hashOAuthState } from './tokenService.js';

const OAUTH_STATE_TTL_MS = 10 * 60_000;

export class OAuthConnectionStateService {
  constructor(private readonly db: Db) {}

  /** Create one-time state bound to userId. Returns raw state for the Google redirect. */
  async create(userId: string): Promise<{ rawState: string; expiresAt: Date }> {
    const rawState = generateOAuthStateToken();
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
    await this.db.insert(oauthConnectionStates).values({
      id: randomUUID(),
      stateHash: hashOAuthState(rawState),
      userId,
      expiresAt,
      consumedAt: null,
      createdAt: new Date(),
    });
    // Opportunistic cleanup
    await this.db
      .delete(oauthConnectionStates)
      .where(lt(oauthConnectionStates.expiresAt, new Date(Date.now() - OAUTH_STATE_TTL_MS)));
    return { rawState, expiresAt };
  }

  /**
   * Consume a one-time state. Returns userId or null if invalid/expired/replayed.
   */
  async consume(rawState: string | undefined | null): Promise<string | null> {
    if (!rawState) return null;
    const stateHash = hashOAuthState(rawState);
    const rows = await this.db
      .select()
      .from(oauthConnectionStates)
      .where(
        and(
          eq(oauthConnectionStates.stateHash, stateHash),
          isNull(oauthConnectionStates.consumedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    const updated = await this.db
      .update(oauthConnectionStates)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(oauthConnectionStates.id, row.id),
          isNull(oauthConnectionStates.consumedAt),
        ),
      )
      .returning({ userId: oauthConnectionStates.userId });
    return updated[0]?.userId ?? null;
  }
}

/** Fetch Google account identity from an access token (requires openid). */
export async function fetchGoogleAccountIdentity(accessToken: string): Promise<{
  sub: string;
  email: string;
} | null> {
  const res = await fetch('https://openidconnect.googleapis.com/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    console.error('google.userinfo failed', { googleStatus: res.status });
    return null;
  }
  const body = (await res.json()) as { sub?: string; email?: string };
  if (!body.sub || !body.email) return null;
  return { sub: body.sub, email: body.email };
}
