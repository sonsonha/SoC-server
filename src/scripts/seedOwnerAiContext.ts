/**
 * Persist the approved AI Context for the explicit initial owner, if blank.
 *
 *   npm run build
 *   npm run ai:seed-owner-context
 */
import { and, eq, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../config.js';
import { closeDb, createDb } from '../infrastructure/db/client.js';
import { users } from '../infrastructure/db/schema/index.js';
import {
  seedOwnerAiContext,
  type OwnerAiContextSeedRepository,
} from '../modules/ai/ownerAiContextSeed.js';
import { normalizeAiContextEmail } from '../modules/ai/userAiContext.js';

loadDotEnv();

async function main() {
  const config = loadConfig();
  const ownerEmail = config.PERSONAL_OS_INITIAL_OWNER_EMAIL?.trim();
  if (!ownerEmail) {
    throw new Error('PERSONAL_OS_INITIAL_OWNER_EMAIL is required');
  }

  const db = createDb(config.DATABASE_URL);
  const repository: OwnerAiContextSeedRepository = {
    async findByNormalizedEmail(email) {
      const rows = await db
        .select({ id: users.id, email: users.email, aiContext: users.aiContext })
        .from(users);
      return rows.filter((row) => normalizeAiContextEmail(row.email) === email);
    },
    async setContextIfBlank(userId, aiContext) {
      const updated = await db
        .update(users)
        .set({ aiContext, updatedAt: new Date() })
        .where(and(
          eq(users.id, userId),
          sql`(${users.aiContext} IS NULL OR btrim(${users.aiContext}) = '')`,
        ))
        .returning({ id: users.id });
      return updated.length === 1;
    },
  };

  try {
    const result = await seedOwnerAiContext(repository, ownerEmail);
    console.log(`Owner: ${result.ownerEmail}`);
    console.log(`Context before: ${result.contextBefore}`);
    console.log(`Action: ${result.action}`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'Failed to seed owner AI Context');
  process.exit(1);
});
