/**
 * Audit Google calendars for leftover legacy CoS plan events
 * (titles like "prace" / "News brief" with location loc-home).
 *
 *   npx tsx scripts/audit-legacy-loc-home-events.ts
 *   npx tsx scripts/audit-legacy-loc-home-events.ts --mutate
 */
import { and, eq, ilike, isNull, or } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import {
  integrationTokens,
  planBlocks,
  timeBlocks,
} from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';
import { IntegrationTokenService } from '../src/modules/integrations/tokenService.js';

loadDotEnv();
const mutate = process.argv.includes('--mutate');

type GEvent = {
  id?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

const TITLE_HINTS = [
  'prace',
  'wordfse',
  'news brief',
  'loc-home',
];

function looksLegacy(ev: GEvent): boolean {
  const summary = (ev.summary ?? '').toLowerCase();
  const location = (ev.location ?? '').toLowerCase();
  if (location === 'loc-home' || location === 'loc-work' || location.startsWith('loc-')) {
    return true;
  }
  if (TITLE_HINTS.some((hint) => summary.includes(hint))) return true;
  // short nonsense test titles often used in early CoS testing
  if (/^(prace|wordfse|ji|ui)$/i.test((ev.summary ?? '').trim())) return true;
  return false;
}

async function listAllEvents(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`list ${calendarId}: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { items?: GEvent[]; nextPageToken?: string };
    out.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

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

    const [tokenRow] = await db
      .select({ writeCalendarId: integrationTokens.writeCalendarId })
      .from(integrationTokens)
      .where(and(
        eq(integrationTokens.userId, user.id),
        eq(integrationTokens.provider, 'google_calendar'),
      ))
      .limit(1);

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
    const calendars = (list.items ?? []).filter((c) => c.id);

    const now = Date.now();
    const timeMin = new Date(now - 14 * 86_400_000).toISOString();
    const timeMax = new Date(now + 30 * 86_400_000).toISOString();

    const legacyPlanBlocks = await db
      .select({
        id: planBlocks.id,
        title: planBlocks.title,
        date: planBlocks.date,
        locationId: planBlocks.locationId,
        externalCalendarEventId: planBlocks.externalCalendarEventId,
        deletedAt: planBlocks.deletedAt,
        ownership: planBlocks.ownership,
        startEpochMs: planBlocks.startEpochMs,
      })
      .from(planBlocks)
      .where(
        or(
          eq(planBlocks.locationId, 'loc-home'),
          ilike(planBlocks.title, '%news brief%'),
          ilike(planBlocks.title, 'prace'),
          ilike(planBlocks.title, 'wordfse'),
          ilike(planBlocks.title, 'ji'),
          ilike(planBlocks.title, 'ui'),
        ),
      )
      .limit(200);

    const liveGoogleIds = new Set(
      (
        await db
          .select({ googleEventId: timeBlocks.googleEventId })
          .from(timeBlocks)
          .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)))
      )
        .map((r) => r.googleEventId)
        .filter((id): id is string => Boolean(id)),
    );

    const findings: Array<{
      calendarId: string;
      calendarSummary: string | null;
      eventId: string;
      summary: string;
      location: string | null;
      start: string | null;
      origin: string | null;
      inLiveTimeBlocks: boolean;
    }> = [];

    for (const cal of calendars) {
      const events = await listAllEvents(accessToken!, cal.id!, timeMin, timeMax);
      for (const ev of events) {
        if (!ev.id || !looksLegacy(ev)) continue;
        findings.push({
          calendarId: cal.id!,
          calendarSummary: cal.summary ?? null,
          eventId: ev.id,
          summary: ev.summary ?? '',
          location: ev.location ?? null,
          start: ev.start?.dateTime ?? ev.start?.date ?? null,
          origin: ev.extendedProperties?.private?.plannerOrigin ?? null,
          inLiveTimeBlocks: liveGoogleIds.has(ev.id),
        });
      }
    }

    console.log(JSON.stringify({
      mode: mutate ? 'mutate' : 'audit',
      writeCalendarId: tokenRow?.writeCalendarId ?? null,
      window: { timeMin, timeMax },
      calendars: calendars.map((c) => ({
        id: c.id,
        summary: c.summary,
        primary: c.primary,
        selected: c.selected,
      })),
      dbLegacyPlanBlocks: {
        count: legacyPlanBlocks.length,
        sample: legacyPlanBlocks.slice(0, 30).map((b) => ({
          id: b.id,
          title: b.title,
          date: b.date,
          locationId: b.locationId,
          externalCalendarEventId: b.externalCalendarEventId,
          deletedAt: b.deletedAt,
          ownership: b.ownership,
          start: b.startEpochMs ? new Date(b.startEpochMs).toISOString() : null,
        })),
      },
      googleLegacyEvents: {
        count: findings.length,
        events: findings,
      },
    }, null, 2));

    if (!mutate) {
      console.error('\nDry-run only. Re-run with --mutate to delete Google events that are legacy loc-* and NOT in live time_blocks.');
      return;
    }

    let deleted = 0;
    let failed = 0;
    for (const ev of findings) {
      if (ev.inLiveTimeBlocks) continue;
      const url =
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ev.calendarId)}/events/${encodeURIComponent(ev.eventId)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok || res.status === 404 || res.status === 410) {
        deleted += 1;
      } else {
        failed += 1;
        console.error('delete failed', ev.eventId, res.status, await res.text());
      }
    }
    console.log(JSON.stringify({ purged: deleted, failed }));
  } finally {
    await closeDb(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
