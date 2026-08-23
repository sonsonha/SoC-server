import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { users } from '../../infrastructure/db/schema/index.js';
import { findUserByEmail } from './plannerOwnership.js';

const DEV_FALLBACK_EMAIL = 'legacy-planner-owner@local';

/**
 * Owner for legacy V1 writers (intake / sync / goal planning / learning)
 * until those paths become session-scoped.
 *
 * Never silently picks an arbitrary user when multiple users exist —
 * requires PERSONAL_OS_INITIAL_OWNER_EMAIL (or a single-user / empty DB
 * only in development/test).
 */
export async function resolveLegacyPlannerOwnerUserId(db: Db): Promise<string> {
  const configured = process.env.PERSONAL_OS_INITIAL_OWNER_EMAIL?.trim();
  if (configured) {
    const user = await findUserByEmail(db, configured);
    if (!user) {
      throw Object.assign(
        new Error(
          `PERSONAL_OS_INITIAL_OWNER_EMAIL=${configured} has no users row — sign in once first`,
        ),
        { statusCode: 503, code: 'OWNER_USER_MISSING' },
      );
    }
    return user.id;
  }

  const rows = await db.select().from(users);
  if (rows.length === 1) {
    return rows[0]!.id;
  }
  if (rows.length > 1) {
    throw Object.assign(
      new Error(
        'PERSONAL_OS_INITIAL_OWNER_EMAIL is required when multiple Personal OS users exist',
      ),
      { statusCode: 503, code: 'OWNER_EMAIL_REQUIRED' },
    );
  }

  // Empty users table (dev/test): create a deterministic local owner.
  if (process.env.NODE_ENV === 'production') {
    throw Object.assign(
      new Error('PERSONAL_OS_INITIAL_OWNER_EMAIL is required in production'),
      { statusCode: 503, code: 'OWNER_EMAIL_REQUIRED' },
    );
  }

  const id = randomUUID();
  await db.insert(users).values({
    id,
    googleSub: `legacy-local-${id}`,
    email: DEV_FALLBACK_EMAIL,
    name: 'Legacy planner owner',
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  });
  return id;
}
