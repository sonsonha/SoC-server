import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { durableJobs } from '../db/schema/planning.js';

export type JobName =
  | 'plan.generate_day'
  | 'plan.replan'
  | 'plan.prepare_tomorrow'
  | 'plan.prepare_week'
  | 'plan.morning_refresh'
  | 'preparation.run'
  | 'preparation.replace'
  | 'preparation.refresh'
  | 'proactive.opportunity_scan'
  | 'proactive.scan'
  | 'calendar.pull'
  | 'calendar.sync_cos';

export type JobPayloadMap = {
  'plan.generate_day': { date: string; taskId?: string; learningItemId?: string };
  'plan.replan': {
    date: string;
    from?: string;
    disruption: { type: string; detail?: string; [key: string]: unknown };
  };
  'plan.prepare_tomorrow': { date?: string };
  'plan.prepare_week': { weekStart?: string; trigger?: string };
  'plan.morning_refresh': { date?: string };
  'preparation.run': { preparationId: string };
  'preparation.replace': { preparationId: string; excludeResourceIds: string[] };
  'preparation.refresh': { preparationId: string };
  'proactive.opportunity_scan': Record<string, never>;
  'proactive.scan': Record<string, never>;
  'calendar.pull': Record<string, never>;
  'calendar.sync_cos': { date: string };
};

type JobHandler<N extends JobName> = (payload: JobPayloadMap[N]) => Promise<void>;

const MAX_ATTEMPTS = 3;

/**
 * Hybrid job queue:
 * - Always executes in-process for low latency.
 * - When `db` is set, also persists to `durable_jobs` so work survives restarts.
 */
export class JobQueue {
  private readonly handlers = new Map<JobName, JobHandler<JobName>>();
  private readonly memoryQueue: Array<{ name: JobName; payload: JobPayloadMap[JobName]; attempts: number }> = [];
  private draining = false;
  private db: Db | null = null;
  private workerId = `worker-${randomUUID().slice(0, 8)}`;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Attach Postgres persistence (call once at boot). */
  setDatabase(db: Db): void {
    this.db = db;
  }

  register<N extends JobName>(name: N, handler: JobHandler<N>): void {
    this.handlers.set(name, handler as JobHandler<JobName>);
  }

  enqueue<N extends JobName>(name: N, payload: JobPayloadMap[N], _opts?: { runAfter?: Date }): void {
    // Immediate in-process execution. Durability for scheduled work uses enqueueDurable.
    this.memoryQueue.push({ name, payload, attempts: 0 });
    this.scheduleDrain();
  }

  /** Persist a future/scheduled job (survives restart). */
  async enqueueDurable<N extends JobName>(
    name: N,
    payload: JobPayloadMap[N],
    runAfter: Date = new Date(),
  ): Promise<string> {
    const id = randomUUID();
    if (!this.db) {
      const delay = Math.max(0, runAfter.getTime() - Date.now());
      setTimeout(() => this.enqueue(name, payload), delay);
      return id;
    }
    await this.db.insert(durableJobs).values({
      id,
      name,
      payload: payload as Record<string, unknown>,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      runAfter,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  startPolling(intervalMs = 15_000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.claimAndRunDurable();
    }, intervalMs);
    void this.claimAndRunDurable();
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => void this.drainMemory());
  }

  private async drainMemory(): Promise<void> {
    while (this.memoryQueue.length > 0) {
      const job = this.memoryQueue.shift()!;
      await this.execute(job.name, job.payload, job.attempts);
    }
    this.draining = false;
    if (this.memoryQueue.length > 0) this.scheduleDrain();
  }

  private async execute(name: JobName, payload: JobPayloadMap[JobName], attempts: number): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      console.error(`No handler for job ${name}`);
      return;
    }
    try {
      await handler(payload);
    } catch (err) {
      const next = attempts + 1;
      if (next < MAX_ATTEMPTS) {
        const delayMs = Math.min(250 * 2 ** next, 2000);
        await new Promise((r) => setTimeout(r, delayMs));
        this.memoryQueue.push({ name, payload, attempts: next });
        // Continue draining; do not schedule async outside the drain loop.
      } else {
        console.error(`Job ${name} failed after ${MAX_ATTEMPTS} attempts`, err);
      }
    }
  }

  private async claimAndRunDurable(): Promise<void> {
    if (!this.db) return;
    const now = new Date();
    const pending = await this.db
      .select()
      .from(durableJobs)
      .where(
        and(
          inArray(durableJobs.status, ['PENDING', 'FAILED']),
          lte(durableJobs.runAfter, now),
        ),
      )
      .limit(10);

    for (const row of pending) {
      if (row.attempts >= row.maxAttempts) {
        await this.db
          .update(durableJobs)
          .set({ status: 'DEAD', updatedAt: now })
          .where(eq(durableJobs.id, row.id));
        continue;
      }

      const locked = await this.db
        .update(durableJobs)
        .set({
          status: 'RUNNING',
          lockedAt: now,
          lockedBy: this.workerId,
          attempts: row.attempts + 1,
          updatedAt: now,
        })
        .where(and(eq(durableJobs.id, row.id), inArray(durableJobs.status, ['PENDING', 'FAILED'])))
        .returning();

      if (!locked[0]) continue;

      const handler = this.handlers.get(row.name as JobName);
      if (!handler) {
        await this.db
          .update(durableJobs)
          .set({ status: 'DEAD', lastError: 'no handler', updatedAt: new Date() })
          .where(eq(durableJobs.id, row.id));
        continue;
      }

      try {
        await handler(row.payload as JobPayloadMap[JobName]);
        await this.db
          .update(durableJobs)
          .set({
            status: 'COMPLETED',
            completedAt: new Date(),
            updatedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          })
          .where(eq(durableJobs.id, row.id));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryAfter = new Date(Date.now() + 250 * 2 ** (row.attempts + 1));
        await this.db
          .update(durableJobs)
          .set({
            status: 'FAILED',
            lastError: message,
            runAfter: retryAfter,
            updatedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          })
          .where(eq(durableJobs.id, row.id));
      }
    }
  }

  async flush(timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (this.memoryQueue.length > 0 || this.draining) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('JobQueue flush timeout');
      }
      await new Promise((r) => setImmediate(r));
    }
  }
}
