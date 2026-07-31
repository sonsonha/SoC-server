import { eq } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import { dailyPlans } from '../../infrastructure/db/schema/dailyPlans.js';
import { planningPreferences } from '../../infrastructure/db/schema/planning.js';

export type PlanningPrefs = typeof planningPreferences.$inferSelect;

const DEFAULTS: Omit<PlanningPrefs, 'updatedAt'> & { updatedAt?: Date } = {
  id: 'default',
  timezone: 'Asia/Ho_Chi_Minh',
  sundayPrepLocalTime: '18:00',
  eveningPrepLocalTime: '21:00',
  morningRefreshOffsetMinutes: 45,
  wakeLocalTime: '07:00',
  capacityUtilization: 0.7,
  autonomy: 'COS_CALENDAR_WRITE',
  workStartLocal: '09:00',
  workEndLocal: '18:00',
  sleepTargetHours: 7.5,
  maxReschedulesBeforeDecision: 3,
};

export async function getPlanningPreferences(db: Db): Promise<PlanningPrefs> {
  const rows = await db.select().from(planningPreferences).where(eq(planningPreferences.id, 'default')).limit(1);
  if (rows[0]) return rows[0];
  await db.insert(planningPreferences).values({ ...DEFAULTS, updatedAt: new Date() }).onConflictDoNothing();
  const again = await db.select().from(planningPreferences).where(eq(planningPreferences.id, 'default')).limit(1);
  return (
    again[0] ?? {
      ...DEFAULTS,
      updatedAt: new Date(),
    }
  );
}

export function autonomyAllowsCalendarWrite(autonomy: string): boolean {
  return autonomy === 'COS_CALENDAR_WRITE' || autonomy === 'PROACTIVE_REPLAN';
}

export function autonomyAllowsInternalActivate(autonomy: string): boolean {
  return (
    autonomy === 'INTERNAL_PLAN' ||
    autonomy === 'COS_CALENDAR_WRITE' ||
    autonomy === 'PROACTIVE_REPLAN'
  );
}

/** Local date key in the given IANA timezone. */
export function localDateKey(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Monday of the week containing `date` (ISO week, Mon–Sun). */
export function weekStartMonday(date: string, timeZone: string): string {
  // Interpret date as local calendar day; find Monday.
  const [y, m, d] = date.split('-').map(Number);
  // Use noon UTC to avoid DST edge when converting weekday in zone.
  const probe = Date.UTC(y, m - 1, d, 12, 0, 0);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(probe));
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = map[weekday] ?? 0;
  return addDays(date, -offset);
}

/** Next Sunday on or after date (for weekly prep target week = upcoming Mon–Sun). */
export function upcomingWeekStartAfterSunday(nowMs: number, timeZone: string): string {
  const today = localDateKey(nowMs, timeZone);
  // Target week = the week that starts the Monday after this Sunday prep.
  // If today is Sunday, prepare week starting tomorrow (Monday).
  // If today is Mon–Sat, prepare the next upcoming week (next Monday).
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(new Date(nowMs));
  if (weekday === 'Sun') {
    return addDays(today, 1);
  }
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const daysUntilNextMonday = 7 - (map[weekday] ?? 0);
  return addDays(today, daysUntilNextMonday);
}

export function parseLocalHm(hm: string): { hour: number; minute: number } {
  const [h, m] = hm.split(':').map(Number);
  return { hour: h || 0, minute: m || 0 };
}

/**
 * Approximate local wall-clock → UTC epoch for fixed-offset zones like Asia/Ho_Chi_Minh (UTC+7).
 * For Vietnam/Singapore no DST — use offset from Intl.
 */
export function localWallToEpochMs(date: string, hm: string, timeZone: string): number {
  const { hour, minute } = parseLocalHm(hm);
  const [y, m, d] = date.split('-').map(Number);
  // Probe offset at that local day noon
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: 'numeric',
  }).formatToParts(probe);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+7';
  const match = tzName.match(/GMT([+-])(\d+)(?::(\d+))?/i);
  let offsetMin = 7 * 60;
  if (match) {
    const sign = match[1] === '-' ? -1 : 1;
    offsetMin = sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  }
  return Date.UTC(y, m - 1, d, hour, minute, 0) - offsetMin * 60_000;
}

export async function markDailyPlanActive(db: Db, date: string): Promise<void> {
  await db
    .update(dailyPlans)
    .set({
      planState: 'ACTIVE',
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(dailyPlans.date, date));
}
