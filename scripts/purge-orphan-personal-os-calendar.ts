/**
 * Fast repair: delete ALL events on the non-canonical Personal OS Google calendar.
 * Does not re-sync (canonical already holds every DB google_event_id).
 *
 *   npx tsx scripts/purge-orphan-personal-os-calendar.ts --mutate
 */
import { and, eq } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { integrationTokens } from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';
import { IntegrationTokenService } from '../src/modules/integrations/tokenService.js';
import { GOOGLE_SYNC_HORIZON_DAYS } from '../src/modules/integrations/calendarSyncHorizon.js';

loadDotEnv();
const mutate = process.argv.includes('--mutate');
const COS = new Set(['personal os', 'personal planner', 'personal chief of staff']);

type GEvent = { id?: string; summary?: string; start?: { dateTime?: string; date?: string } };

async function main() {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl || /localhost|127\.0\.0\.1|railway\.internal/.test(dbUrl)) {
    throw new Error('production public DATABASE_URL required');
  }
  const config = loadConfig();
  const db = createDb(dbUrl);
  const tokenService = new IntegrationTokenService(
    db,
    config.INTEGRATION_ENCRYPTION_KEY ?? config.DEVICE_AUTH_PEPPER,
  );
  try {
    const user = await findUserByEmail(db, OWNER_REAL_PLAN_EMAIL);
    if (!user) throw new Error('owner not found');
    const [row] = await db
      .select({ writeCalendarId: integrationTokens.writeCalendarId })
      .from(integrationTokens)
      .where(and(
        eq(integrationTokens.userId, user.id),
        eq(integrationTokens.provider, 'google_calendar'),
      ))
      .limit(1);
    const canonical = row?.writeCalendarId;
    if (!canonical) throw new Error('no write_calendar_id');

    let tokens = await tokenService.getGoogleCalendarTokens(user.id);
    if (!tokens?.accessToken) throw new Error('no google tokens');
    if (tokens.expiresAt && tokens.expiresAt.getTime() < Date.now() + 60_000) {
      tokens = await tokenService.refreshGoogleAccessToken(user.id, {
        clientId: config.GOOGLE_OAUTH_CLIENT_ID!,
        clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET!,
      });
    }
    const accessToken = tokens!.accessToken;

    const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const list = (await listRes.json()) as {
      items?: Array<{ id?: string; summary?: string; primary?: boolean; selected?: boolean }>;
    };
    const extras = (list.items ?? []).filter(
      (c) => c.id
        && c.id !== canonical
        && !c.primary
        && c.summary
        && COS.has(c.summary.toLowerCase()),
    );

    const now = Date.now();
    const timeMin = new Date(now - 7 * 86_400_000).toISOString();
    const timeMax = new Date(now + GOOGLE_SYNC_HORIZON_DAYS * 86_400_000).toISOString();

    console.log(JSON.stringify({
      mode: mutate ? 'mutate' : 'audit',
      canonical,
      extras: extras.map((e) => ({ id: e.id, summary: e.summary, selected: e.selected })),
      window: { timeMin, timeMax },
    }, null, 2));

    for (const extra of extras) {
      const events: GEvent[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          timeMin,
          timeMax,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '2500',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(extra.id!)}/events?${params}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const data = (await res.json()) as { items?: GEvent[]; nextPageToken?: string };
        if (!res.ok) throw new Error(`list failed ${res.status}`);
        events.push(...(data.items ?? []));
        pageToken = data.nextPageToken;
      } while (pageToken);

      console.log(JSON.stringify({
        extraId: extra.id,
        eventCount: events.length,
        sample: events.slice(0, 5).map((e) => e.summary),
      }));

      if (!mutate) continue;

      let deleted = 0;
      let failed = 0;
      for (const ev of events) {
        if (!ev.id) continue;
        const del = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(extra.id!)}/events/${encodeURIComponent(ev.id)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (del.ok || del.status === 204 || del.status === 404 || del.status === 410) deleted += 1;
        else failed += 1;
      }
      console.log(JSON.stringify({ purged: extra.id, deleted, failed }));
    }

    if (!mutate) console.error('\nDry-run. Re-run with --mutate to delete orphan calendar events.');
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
