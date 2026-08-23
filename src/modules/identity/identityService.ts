import { and, eq, isNull, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { authSessions, users } from '../../infrastructure/db/schema/index.js';
import {
  generateSessionToken,
  hashSessionToken,
  type VerifiedGoogleIdentity,
} from './googleIdToken.js';

export const SESSION_COOKIE_NAME = 'pos_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type PublicUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  onboardingCompletedAt: string | null;
};

export type SessionUser = PublicUser & {
  googleSub: string;
};

function toPublic(user: typeof users.$inferSelect): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
  };
}

export function parseAllowedEmails(raw?: string): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isEmailAllowlisted(email: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return false;
  return allowed.has(email.trim().toLowerCase());
}

export class IdentityService {
  constructor(
    private readonly db: Db,
    private readonly allowedEmails: Set<string>,
    private readonly initialOwnerEmail?: string,
  ) {}

  isAllowlisted(email: string): boolean {
    return isEmailAllowlisted(email, this.allowedEmails);
  }

  getInitialOwnerEmail(): string | undefined {
    return this.initialOwnerEmail?.trim() || undefined;
  }

  async getUserById(id: string): Promise<SessionUser | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return { ...toPublic(row), googleSub: row.googleSub };
  }

  /** Legacy device path — maps to initial owner only (Batch B/C). */
  async resolveInitialOwnerUser(): Promise<SessionUser | null> {
    const email = this.getInitialOwnerEmail();
    if (!email) return null;
    const rows = await this.db.select().from(users);
    const row = rows.find((u) => u.email.trim().toLowerCase() === email.toLowerCase());
    if (!row) return null;
    return { ...toPublic(row), googleSub: row.googleSub };
  }

  isLegacyCalendarOwner(email: string): boolean {
    const owner = this.getInitialOwnerEmail();
    if (!owner) return true;
    return email.trim().toLowerCase() === owner.toLowerCase();
  }

  async upsertGoogleUser(identity: VerifiedGoogleIdentity): Promise<SessionUser> {
    const existing = await this.db
      .select()
      .from(users)
      .where(eq(users.googleSub, identity.sub))
      .limit(1);
    const now = new Date();
    if (existing[0]) {
      await this.db
        .update(users)
        .set({
          email: identity.email,
          name: identity.name,
          avatarUrl: identity.picture,
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, existing[0].id));
      const refreshed = await this.db
        .select()
        .from(users)
        .where(eq(users.id, existing[0].id))
        .limit(1);
      const row = refreshed[0]!;
      return { ...toPublic(row), googleSub: row.googleSub };
    }

    const id = randomUUID();
    await this.db.insert(users).values({
      id,
      googleSub: identity.sub,
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.picture,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    });
    return {
      id,
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.picture,
      googleSub: identity.sub,
      onboardingCompletedAt: null,
    };
  }

  async createSession(userId: string): Promise<{ rawToken: string; expiresAt: Date }> {
    const rawToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.insert(authSessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: new Date(),
      expiresAt,
      lastSeenAt: new Date(),
      revokedAt: null,
    });
    // Opportunistic cleanup of expired sessions for this user.
    await this.db
      .delete(authSessions)
      .where(and(eq(authSessions.userId, userId), lt(authSessions.expiresAt, new Date())));
    return { rawToken, expiresAt };
  }

  async resolveSession(rawToken: string | undefined | null): Promise<SessionUser | null> {
    if (!rawToken) return null;
    const tokenHash = hashSessionToken(rawToken);
    const rows = await this.db
      .select({
        sessionId: authSessions.id,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
        user: users,
      })
      .from(authSessions)
      .innerJoin(users, eq(authSessions.userId, users.id))
      .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    await this.db
      .update(authSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(authSessions.id, row.sessionId));
    return { ...toPublic(row.user), googleSub: row.user.googleSub };
  }

  async revokeSession(rawToken: string | undefined | null): Promise<void> {
    if (!rawToken) return;
    const tokenHash = hashSessionToken(rawToken);
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)));
  }

  async markOnboardingCompleted(userId: string): Promise<PublicUser> {
    const now = new Date();
    const existing = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const row = existing[0];
    if (!row) {
      throw Object.assign(new Error('User not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }
    if (row.onboardingCompletedAt) {
      return toPublic(row);
    }
    await this.db
      .update(users)
      .set({ onboardingCompletedAt: now, updatedAt: now })
      .where(eq(users.id, userId));
    return toPublic({ ...row, onboardingCompletedAt: now, updatedAt: now });
  }
}

export function buildSessionCookie(
  rawToken: string,
  expiresAt: Date,
  opts: { secure: boolean },
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function readSessionTokenFromCookieHeader(
  cookieHeader: string | string[] | undefined,
): string | null {
  if (!cookieHeader) return null;
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    const value = trimmed.slice(SESSION_COOKIE_NAME.length + 1);
    return value || null;
  }
  return null;
}
