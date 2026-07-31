import type { Db } from '../../infrastructure/db/client.js';
import type { JobQueue } from '../../infrastructure/jobs/jobQueue.js';
import {
  getPlanningPreferences,
  localDateKey,
  localWallToEpochMs,
  upcomingWeekStartAfterSunday,
  addDays,
} from './planningPrefs.js';

/**
 * Timezone-aware recurring planner that enqueues durable jobs.
 * Runs a tick every minute when WORKER_ENABLED.
 */
export class PlanningScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSundayKey: string | null = null;
  private lastEveningKey: string | null = null;
  private lastMorningKey: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
  ) {}

  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    const prefs = await getPlanningPreferences(this.db);
    const tz = prefs.timezone;
    const today = localDateKey(nowMs, tz);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(
      new Date(nowMs),
    );

    // Sunday weekly prep window (±2 minutes around configured local time)
    if (weekday === 'Sun') {
      const target = localWallToEpochMs(today, prefs.sundayPrepLocalTime, tz);
      if (Math.abs(nowMs - target) <= 2 * 60_000 && this.lastSundayKey !== today) {
        this.lastSundayKey = today;
        const weekStart = upcomingWeekStartAfterSunday(nowMs, tz);
        void this.jobs.enqueueDurable('plan.prepare_week', { weekStart, trigger: 'SCHEDULE' }, new Date());
      }
    }

    // Evening tomorrow prep
    {
      const target = localWallToEpochMs(today, prefs.eveningPrepLocalTime, tz);
      if (Math.abs(nowMs - target) <= 2 * 60_000 && this.lastEveningKey !== today) {
        this.lastEveningKey = today;
        const tomorrow = addDays(today, 1);
        void this.jobs.enqueueDurable('plan.prepare_tomorrow', { date: tomorrow }, new Date());
      }
    }

    // Morning refresh: wakeLocalTime − offset
    {
      const { hour, minute } = parseHm(prefs.wakeLocalTime);
      const offset = prefs.morningRefreshOffsetMinutes;
      const totalMin = hour * 60 + minute - offset;
      const rh = Math.floor((((totalMin % (24 * 60)) + 24 * 60) % (24 * 60)) / 60);
      const rm = ((totalMin % (24 * 60)) + 24 * 60) % 60;
      const hm = `${String(rh).padStart(2, '0')}:${String(rm).padStart(2, '0')}`;
      const target = localWallToEpochMs(today, hm, tz);
      if (Math.abs(nowMs - target) <= 2 * 60_000 && this.lastMorningKey !== today) {
        this.lastMorningKey = today;
        void this.jobs.enqueueDurable('plan.morning_refresh', { date: today }, new Date());
      }
    }
  }
}

function parseHm(hm: string): { hour: number; minute: number } {
  const [h, m] = hm.split(':').map(Number);
  return { hour: h || 0, minute: m || 0 };
}
