#!/usr/bin/env tsx
/**
 * Mark onboarding completed for the explicit initial owner (Batch D).
 * Avoids forcing Welcome on the long-time production account.
 *
 *   PERSONAL_OS_INITIAL_OWNER_EMAIL=you@example.com npm run onboarding:backfill-owner
 */
import { eq, isNull } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { users } from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail, findUserById } from '../src/modules/identity/plannerOwnership.js';

loadDotEnv();

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main() {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);
  const db = createDb(config.DATABASE_URL);
  try {
    const email =
      argValue('email')
      ?? process.env.PERSONAL_OS_INITIAL_OWNER_EMAIL
      ?? config.PERSONAL_OS_INITIAL_OWNER_EMAIL;
    const userIdArg = argValue('user-id');
    let ownerId: string;
    if (userIdArg) {
      const user = await findUserById(db, userIdArg);
      if (!user) throw new Error(`No user id ${userIdArg}`);
      ownerId = user.id;
    } else if (email) {
      const user = await findUserByEmail(db, email);
      if (!user) throw new Error(`No user email ${email}`);
      ownerId = user.id;
    } else {
      throw new Error('Provide --email=, --user-id=, or PERSONAL_OS_INITIAL_OWNER_EMAIL');
    }

    const now = new Date();
    await db
      .update(users)
      .set({ onboardingCompletedAt: now, updatedAt: now })
      .where(eq(users.id, ownerId));

    const stillNull = await db
      .select()
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (!stillNull[0]?.onboardingCompletedAt) {
      throw new Error('Failed to set onboarding_completed_at');
    }
    console.log(`Onboarding marked complete for ${stillNull[0].email} (${ownerId})`);

    // Optional: do not touch other users with null onboarding
    const pending = await db.select({ id: users.id }).from(users).where(isNull(users.onboardingCompletedAt));
    console.log(`Other users still pending onboarding: ${pending.length}`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
