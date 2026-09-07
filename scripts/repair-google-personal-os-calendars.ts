/**
 * Audit / repair split "Personal OS" Google calendars.
 *
 * Problem: two calendars both named Personal OS hold disjoint event sets.
 * Toggling either shows a different incomplete week. Neither alone is complete.
 *
 * Fix (--mutate):
 * 1. Pick canonical = integration_tokens.write_calendar_id (or most DB matches)
 * 2. Force re-sync all live time_blocks in the Google horizon onto canonical
 * 3. Delete planner-origin events on every non-canonical Personal OS calendar
 * 4. Hide non-canonical calendars in Google sidebar
 *
 * Default: dry-run audit only.
 *
 *   npx tsx scripts/repair-google-personal-os-calendars.ts
 *   npx tsx scripts/repair-google-personal-os-calendars.ts --mutate
 */
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { integrationTokens, timeBlocks } from '../src/infrastructure/db/schema/index.js';
import { PlannerV2Service } from '../src/application/plannerV2Service.js';
import { GOOGLE_SYNC_HORIZON_DAYS } from '../src/modules/integrations/calendarSyncHorizon.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';
import { IntegrationTokenService } from '../src/modules/integrations/tokenService.js';
import { createUserCalendarProviderAsync } from '../src/modules/integrations/userCalendarProvider.js';

loadDotEnv();

const mutate = process.argv.includes('--mutate');
const COS_NAMES = new Set(['personal os', 'personal planner', 'personal chief of staff']);

type CalItem = {
  id: string;
  summary: string;
  selected?: boolean;
  primary?: boolean;
  backgroundColor?: string;
};

type GEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

function productWeekKey(epochMs: number): string {
  const d = new Date(epochMs);
  // Monday-based week key in Asia/Ho_Chi_Minh
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  const local = new Date(Date.UTC(y, m - 1, day));
  const dow = local.getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  local.setUTCDate(local.getUTCDate() + mondayOffset);
  return local.toISOString().slice(0, 10);
}

async function googleFetch<T>(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? JSON.parse(text) as T : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function listAllEvents(
  accessToken: string,
  calendarId: string,
  fromIso: string,
  toIso: string,
): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: fromIso,
      timeMax: toIso,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const { ok, status, data, text } = await googleFetch<{
      items?: GEvent[];
      nextPageToken?: string;
    }>(accessToken, url);
    if (!ok) throw new Error(`list events ${calendarId} failed ${status}: ${text.slice(0, 200)}`);
    out.push(...(data?.items ?? []));
    pageToken = data?.nextPageToken;
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
  const encryptionKey = config.INTEGRATION_ENCRYPTION_KEY ?? config.DEVICE_AUTH_PEPPER;
  const tokenService = new IntegrationTokenService(db, encryptionKey);

  try {
    const user = await findUserByEmail(db, OWNER_REAL_PLAN_EMAIL);
    if (!user) throw new Error('owner not found');

    const [tokenRow] = await db
      .select({
        writeCalendarId: integrationTokens.writeCalendarId,
      })
      .from(integrationTokens)
      .where(and(
        eq(integrationTokens.userId, user.id),
        eq(integrationTokens.provider, 'google_calendar'),
      ))
      .limit(1);

    const storedWrite = tokenRow?.writeCalendarId ?? null;

    const tokens = await tokenService.getGoogleCalendarTokens(user.id);
    if (!tokens?.accessToken) throw new Error('No Google Calendar tokens for owner');

    let accessToken = tokens.accessToken;
    if (tokens.expiresAt && tokens.expiresAt.getTime() < Date.now() + 60_000) {
      const refreshed = await tokenService.refreshGoogleAccessToken(user.id, {
        clientId: config.GOOGLE_OAUTH_CLIENT_ID!,
        clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET!,
      });
      if (!refreshed?.accessToken) throw new Error('token refresh failed');
      accessToken = refreshed.accessToken;
    }

    const listRes = await googleFetch<{ items?: CalItem[] }>(
      accessToken,
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    );
    if (!listRes.ok) throw new Error(`calendarList failed ${listRes.status}`);
    const allCals = listRes.data?.items ?? [];
    const cosCals = allCals.filter(
      (c) => c.id && c.summary && COS_NAMES.has(c.summary.toLowerCase()) && !c.primary,
    );

    const now = Date.now();
    const fromMs = now - 86_400_000;
    const toMs = now + GOOGLE_SYNC_HORIZON_DAYS * 86_400_000;
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMs).toISOString();

    const blocks = await db
      .select({
        id: timeBlocks.id,
        title: timeBlocks.title,
        start: timeBlocks.startEpochMs,
        googleEventId: timeBlocks.googleEventId,
        syncStatus: timeBlocks.syncStatus,
      })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          isNull(timeBlocks.deletedAt),
          lt(timeBlocks.startEpochMs, toMs),
          gt(timeBlocks.endEpochMs, fromMs),
        ),
      );

    const dbIds = new Set(
      blocks.map((b) => b.googleEventId).filter((id): id is string => Boolean(id) && !id.startsWith('cos-')),
    );

    const perCal: Array<{
      id: string;
      summary: string;
      selected: boolean;
      color: string | null;
      isStoredWrite: boolean;
      eventCount: number;
      dbMatchCount: number;
      byWeek: Record<string, number>;
      sampleTitles: string[];
    }> = [];

    for (const cal of cosCals) {
      const events = await listAllEvents(accessToken, cal.id, fromIso, toIso);
      const dbMatchCount = events.filter((e) => e.id && dbIds.has(e.id)).length;
      const byWeek: Record<string, number> = {};
      for (const ev of events) {
        const start = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00+07:00` : null);
        if (!start) continue;
        const week = productWeekKey(Date.parse(start));
        byWeek[week] = (byWeek[week] ?? 0) + 1;
      }
      perCal.push({
        id: cal.id,
        summary: cal.summary,
        selected: Boolean(cal.selected),
        color: cal.backgroundColor ?? null,
        isStoredWrite: cal.id === storedWrite,
        eventCount: events.length,
        dbMatchCount,
        byWeek,
        sampleTitles: events.slice(0, 8).map((e) => e.summary ?? '(no title)'),
      });
    }

    // Canonical: stored write if present among cos, else most DB matches, else most events.
    let canonical = perCal.find((c) => c.isStoredWrite)
      ?? [...perCal].sort((a, b) => b.dbMatchCount - a.dbMatchCount || b.eventCount - a.eventCount)[0]
      ?? null;

    const blocksMissingOnCanonical = blocks.filter((b) => {
      if (!canonical) return true;
      if (!b.googleEventId || b.googleEventId.startsWith('cos-')) return true;
      // Will verify after listing canonical events
      return false;
    });

    let canonicalEventIds = new Set<string>();
    if (canonical) {
      const events = await listAllEvents(accessToken, canonical.id, fromIso, toIso);
      canonicalEventIds = new Set(events.map((e) => e.id).filter(Boolean));
    }

    const blocksNotOnCanonical = blocks.filter((b) => {
      if (!b.googleEventId || b.googleEventId.startsWith('cos-')) return true;
      return !canonicalEventIds.has(b.googleEventId);
    });

    const report = {
      mode: mutate ? 'mutate' : 'audit',
      owner: OWNER_REAL_PLAN_EMAIL,
      storedWriteCalendarId: storedWrite,
      horizonDays: GOOGLE_SYNC_HORIZON_DAYS,
      window: { fromIso, toIso },
      liveBlocksInWindow: blocks.length,
      blocksWithGoogleId: blocks.filter((b) => b.googleEventId && !b.googleEventId.startsWith('cos-')).length,
      personalOsCalendars: perCal,
      canonical: canonical
        ? { id: canonical.id, summary: canonical.summary, dbMatchCount: canonical.dbMatchCount }
        : null,
      diagnosis: {
        splitCalendars: perCal.length > 1,
        neitherCompleteAlone: perCal.length > 1
          && perCal.every((c) => c.dbMatchCount < blocks.filter((b) => b.googleEventId).length),
        blocksNotOnCanonical: blocksNotOnCanonical.length,
        explanation:
          'Events were written across two Personal OS calendars during a race. '
          + 'Checking only one calendar shows a partial schedule; checking both shows duplicates. '
          + 'Personal OS web is complete because it reads time_blocks, not Google.',
      },
      sampleMissingOnCanonical: blocksNotOnCanonical.slice(0, 15).map((b) => ({
        id: b.id,
        title: b.title,
        start: new Date(b.start).toISOString(),
        googleEventId: b.googleEventId,
        week: productWeekKey(b.start),
      })),
    };

    console.log(JSON.stringify(report, null, 2));

    if (!mutate) {
      console.error('\nDry-run only. Re-run with --mutate to consolidate onto canonical + purge extras.');
      return;
    }

    if (!canonical) throw new Error('No Personal OS calendar found to use as canonical');

    // Persist canonical write id
    await tokenService.setWriteCalendarId(user.id, canonical.id);

    const planner = new PlannerV2Service(
      db,
      async () => createUserCalendarProviderAsync({
        userId: user.id,
        tokenService,
        config,
        allowLegacyCosCalendarFallback: true,
      }),
    );

    // Clear stale google ids that are NOT on canonical so upsert recreates there
    // (avoids PATCH targeting wrong calendar via id that only exists on orphan).
    for (const b of blocksNotOnCanonical) {
      if (!b.googleEventId) continue;
      await db
        .update(timeBlocks)
        .set({
          googleEventId: null,
          syncStatus: 'PENDING',
          updatedAt: new Date(),
        })
        .where(and(eq(timeBlocks.id, b.id), eq(timeBlocks.userId, user.id)));
    }

    const syncResult = await planner.retryCalendarSync(user.id);
    console.log(JSON.stringify({ syncResult }, null, 2));

    // Delete ALL events on non-canonical Personal OS calendars in the horizon
    const extras = cosCals.filter((c) => c.id !== canonical!.id);
    let deleted = 0;
    for (const extra of extras) {
      const events = await listAllEvents(accessToken, extra.id, fromIso, toIso);
      for (const ev of events) {
        if (!ev.id) continue;
        const del = await googleFetch(
          accessToken,
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(extra.id)}/events/${encodeURIComponent(ev.id)}`,
          { method: 'DELETE' },
        );
        if (del.ok || del.status === 404 || del.status === 410) deleted += 1;
        else {
          console.warn('delete failed', { calendarId: extra.id, eventId: ev.id, status: del.status });
        }
      }
      // Hide extra calendar
      const hide = await googleFetch(
        accessToken,
        `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(extra.id)}?colorRgbFormat=true`,
        { method: 'PATCH', body: JSON.stringify({ selected: false, hidden: true }) },
      );
      console.log(JSON.stringify({
        hidExtra: extra.id,
        summary: extra.summary,
        hideOk: hide.ok,
        eventsDeletedFromExtra: events.length,
      }));
    }

    // Ensure canonical selected + green
    await googleFetch(
      accessToken,
      `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(canonical.id)}?colorRgbFormat=true`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          selected: true,
          hidden: false,
          backgroundColor: '#166534',
          foregroundColor: '#ffffff',
        }),
      },
    );

    console.log(JSON.stringify({
      done: true,
      canonicalId: canonical.id,
      deletedFromExtras: deleted,
      extrasCleared: extras.map((c) => c.id),
    }, null, 2));
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
