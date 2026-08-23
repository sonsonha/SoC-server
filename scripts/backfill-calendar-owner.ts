#!/usr/bin/env tsx
/**
 * Assign singleton Google Calendar rows to the explicit Batch B owner.
 *
 *   PERSONAL_OS_INITIAL_OWNER_EMAIL=you@example.com npm run calendar:backfill-owner
 */
import { eq, isNull, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import {
  calendarCommitments,
  calendarSyncState,
  integrationTokens,
} from '../src/infrastructure/db/schema/index.js';
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
      console.log(`Owner: ${user.email} (${user.id})`);
    } else if (email) {
      const user = await findUserByEmail(db, email);
      if (!user) throw new Error(`No user email ${email} — sign in once first`);
      ownerId = user.id;
      console.log(`Owner: ${user.email} (${user.id})`);
    } else {
      throw new Error('Provide --email=, --user-id=, or PERSONAL_OS_INITIAL_OWNER_EMAIL');
    }

    const beforeTokens = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationTokens)
      .where(isNull(integrationTokens.userId));
    const beforeCommitments = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(calendarCommitments)
      .where(isNull(calendarCommitments.userId));

    await db
      .update(integrationTokens)
      .set({ userId: ownerId })
      .where(isNull(integrationTokens.userId));
    await db
      .update(calendarCommitments)
      .set({ userId: ownerId })
      .where(isNull(calendarCommitments.userId));

    // Migrate legacy sync row id=default → per-user row
    const defaultSync = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.id, 'default'))
      .limit(1);
    if (defaultSync[0] && !defaultSync[0].userId) {
      const existingUserSync = await db
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.userId, ownerId))
        .limit(1);
      if (!existingUserSync[0]) {
        await db.insert(calendarSyncState).values({
          id: ownerId,
          userId: ownerId,
          lastSyncAt: defaultSync[0].lastSyncAt,
          lastSyncToken: defaultSync[0].lastSyncToken,
          lastReplanAt: defaultSync[0].lastReplanAt,
          updatedAt: new Date(),
        });
      }
      await db.delete(calendarSyncState).where(eq(calendarSyncState.id, 'default'));
    }

    // If owner already has tokens and a null-user singleton existed, both may exist —
    // unique (user_id, provider) may fail; report remaining nulls.
    const afterNullTokens = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationTokens)
      .where(isNull(integrationTokens.userId));
    const afterNullCommitments = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(calendarCommitments)
      .where(isNull(calendarCommitments.userId));

    console.log({
      nullTokensBefore: beforeTokens[0]?.n ?? 0,
      nullCommitmentsBefore: beforeCommitments[0]?.n ?? 0,
      nullTokensAfter: afterNullTokens[0]?.n ?? 0,
      nullCommitmentsAfter: afterNullCommitments[0]?.n ?? 0,
    });

    if ((afterNullTokens[0]?.n ?? 0) > 0 || (afterNullCommitments[0]?.n ?? 0) > 0) {
      throw new Error('NULL user_id rows remain — resolve duplicates manually');
    }
    console.log('Calendar ownership backfill OK.');
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
