/**
 * Production: migrate session Daily Focus + allocate week 2026-09-07..13 for owner.
 * Uses the live per-user Google Calendar provider (real sync for new Sessions).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { tasks, timeBlocks, users } from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';
import { seedOwnerWeekPlan } from '../src/modules/planner/seedOwnerWeekPlan.js';
import { IntegrationTokenService } from '../src/modules/integrations/tokenService.js';
import { createUserCalendarProviderAsync } from '../src/modules/integrations/userCalendarProvider.js';
import { IdentityService, parseAllowedEmails } from '../src/modules/identity/identityService.js';
import { INITIAL_OWNER_AI_CONTEXT_DEFAULT } from '../src/modules/ai/ownerAiContextDefault.js';

loadDotEnv();

const OWNER = OWNER_REAL_PLAN_EMAIL;
const mode = process.argv.includes('--mutate') ? 'mutate' : 'audit';

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL required');
  if (/localhost|127\.0\.0\.1/.test(dbUrl)) {
    throw new Error('Refusing local DATABASE_URL — production Railway only');
  }

  console.log('MODE', mode);
  const db = createDb(dbUrl);
  try {
    const user = await findUserByEmail(db, OWNER);
    if (!user) throw new Error(`User not found: ${OWNER}`);
    console.log('USER', { id: user.id, email: user.email });

    const [focusTasks] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, user.id),
          isNull(tasks.deletedAt),
          sql`daily_focus_date is not null`,
        ),
      );
    console.log('LEGACY_TASK_DAILY_FOCUS', focusTasks?.c ?? 0);

    if (mode === 'audit') {
      console.log('PLAN: migrate 0032 + seedOwnerWeekPlan with live Google calendar');
      return;
    }

    await runMigrations(dbUrl);

    await db
      .update(users)
      .set({ aiContext: INITIAL_OWNER_AI_CONTEXT_DEFAULT, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const encryptionKey =
      config.INTEGRATION_ENCRYPTION_KEY ?? config.DEVICE_AUTH_PEPPER;
    const tokenService = new IntegrationTokenService(db, encryptionKey);
    const identityService = new IdentityService(
      db,
      parseAllowedEmails(config.PERSONAL_OS_ALLOWED_EMAILS),
      config.PERSONAL_OS_INITIAL_OWNER_EMAIL?.trim() || undefined,
    );

    const resolveCalendar = async (userId: string) => {
      const u = await identityService.getUserById(userId);
      const allowLegacyCosCalendarFallback = u
        ? identityService.isLegacyCalendarOwner(u.email)
        : false;
      return createUserCalendarProviderAsync({
        userId,
        tokenService,
        config,
        allowLegacyCosCalendarFallback,
      });
    };

    const report = await seedOwnerWeekPlan(db, resolveCalendar, OWNER);
    console.log(JSON.stringify(report, null, 2));

    const weekStart = Date.parse('2026-09-07T00:00:00+07:00');
    const weekEnd = Date.parse('2026-09-14T00:00:00+07:00');
    const [focusSessions] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          isNull(timeBlocks.deletedAt),
          eq(timeBlocks.isDailyFocus, true),
          sql`start_epoch_ms >= ${weekStart} and start_epoch_ms < ${weekEnd}`,
        ),
      );
    console.log('WEEK_FOCUS_SESSIONS', focusSessions?.c ?? 0);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
