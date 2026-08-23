#!/usr/bin/env tsx
/**
 * One-time / idempotent backfill: assign NULL-owned planner roots to an explicit owner.
 *
 * Usage:
 *   PERSONAL_OS_INITIAL_OWNER_EMAIL=you@example.com npm run planner:backfill-owner
 *   npm run planner:backfill-owner -- --email=you@example.com
 *   npm run planner:backfill-owner -- --user-id=<users.id>
 *
 * Does NOT pick "first user" automatically.
 */
import { loadConfig, loadDotEnv } from '../config.js';
import { closeDb, createDb } from '../infrastructure/db/client.js';
import { runMigrations } from '../infrastructure/db/migrate.js';
import {
  assertNoNullOwnership,
  backfillPlannerOwner,
  countCrossUserRelations,
  countPlannerOwnership,
  findUserByEmail,
  findUserById,
} from '../modules/identity/plannerOwnership.js';

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
    const before = await countPlannerOwnership(db);
    console.log('Before backfill:', before);

    const email =
      argValue('email')
      ?? process.env.PERSONAL_OS_INITIAL_OWNER_EMAIL
      ?? config.PERSONAL_OS_INITIAL_OWNER_EMAIL;
    const userIdArg = argValue('user-id');

    let ownerId: string | null = null;
    if (userIdArg) {
      const user = await findUserById(db, userIdArg);
      if (!user) {
        throw new Error(`No user with id ${userIdArg}. Sign in once so the users row exists.`);
      }
      ownerId = user.id;
      console.log(`Owner: ${user.email} (${user.id})`);
    } else if (email) {
      const user = await findUserByEmail(db, email);
      if (!user) {
        throw new Error(
          `No user with email ${email}. Sign in to Personal OS once before backfill.`,
        );
      }
      ownerId = user.id;
      console.log(`Owner: ${user.email} (${user.id})`);
    } else {
      throw new Error(
        'Provide --email=, --user-id=, or PERSONAL_OS_INITIAL_OWNER_EMAIL. Refusing to guess.',
      );
    }

    await backfillPlannerOwner(db, ownerId);
    await assertNoNullOwnership(db);
    const after = await countPlannerOwnership(db);
    const cross = await countCrossUserRelations(db);
    console.log('After backfill:', after);
    console.log('Cross-user relations:', cross);

    if (
      after.goals !== before.goals
      || after.projects !== before.projects
      || after.tasks !== before.tasks
      || after.timeBlocks !== before.timeBlocks
    ) {
      throw new Error('Row counts changed during backfill — aborting mentally; investigate.');
    }

    console.log('Backfill OK. Next: ensure migration 0018 has been applied (npm run db:migrate).');
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
