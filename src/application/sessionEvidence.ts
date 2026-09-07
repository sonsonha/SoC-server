/**
 * Session-evidence rules: Task progress/completion derives from TimeBlock sessions.
 * Pure helpers — no DB access.
 *
 * High-value Tasks with Definition of Done require explicit outcome confirmation
 * before Task status becomes DONE (sessions alone are insufficient).
 */

export type SessionEvidenceBlock = {
  id: string;
  status: string;
  deletedAt?: Date | null;
};

export type TaskProgressFromSessions = {
  activeCount: number;
  completedCount: number;
  progressPercent: number;
  /** Session progress hint — may be DONE while Task stays open if outcome required. */
  progressState: 'UNSCHEDULED' | 'NOT_STARTED' | 'PARTIAL' | 'DONE';
  /**
   * Derived Task status from Sessions alone.
   * Callers with Definition of Done must not treat DONE as final Task outcome
   * until outcomeAchieved is true.
   */
  derivedTaskStatus: 'INBOX' | 'SCHEDULED' | 'DONE';
};

export function isSessionDone(status: string | null | undefined) {
  const value = (status ?? '').toUpperCase();
  return value === 'DONE' || value === 'COMPLETED';
}

export function activeSessions(blocks: SessionEvidenceBlock[]) {
  return blocks.filter((block) => !block.deletedAt);
}

export function taskRequiresOutcomeConfirm(definitionOfDone: string | null | undefined) {
  return Boolean(definitionOfDone?.trim());
}

/**
 * Final persisted Task status considering Sessions + optional Definition of Done.
 */
export function resolveTaskStatusFromEvidence(input: {
  definitionOfDone?: string | null;
  outcomeAchieved?: boolean;
  sessionDerived: TaskProgressFromSessions['derivedTaskStatus'];
}): 'INBOX' | 'SCHEDULED' | 'DONE' {
  if (input.outcomeAchieved) return 'DONE';
  if (taskRequiresOutcomeConfirm(input.definitionOfDone)) {
    // Sessions may all be complete, but outcome is not confirmed yet.
    if (input.sessionDerived === 'DONE') return 'SCHEDULED';
    return input.sessionDerived;
  }
  return input.sessionDerived;
}

export function deriveTaskProgressFromSessions(
  blocks: SessionEvidenceBlock[],
): TaskProgressFromSessions {
  const active = activeSessions(blocks);
  const activeCount = active.length;
  if (activeCount === 0) {
    return {
      activeCount: 0,
      completedCount: 0,
      progressPercent: 0,
      progressState: 'UNSCHEDULED',
      derivedTaskStatus: 'INBOX',
    };
  }
  const completedCount = active.filter((block) => isSessionDone(block.status)).length;
  const progressPercent = Math.round((completedCount / activeCount) * 100);
  if (completedCount === 0) {
    return {
      activeCount,
      completedCount,
      progressPercent: 0,
      progressState: 'NOT_STARTED',
      derivedTaskStatus: 'SCHEDULED',
    };
  }
  if (completedCount >= activeCount) {
    return {
      activeCount,
      completedCount,
      progressPercent: 100,
      progressState: 'DONE',
      derivedTaskStatus: 'DONE',
    };
  }
  return {
    activeCount,
    completedCount,
    progressPercent,
    progressState: 'PARTIAL',
    derivedTaskStatus: 'SCHEDULED',
  };
}

/**
 * Direct Mark Task Done is only allowed for exactly one active Session
 * and only when the Task does NOT require Definition-of-Done confirmation.
 */
export type DirectTaskCompletePolicy =
  | { allow: true; mode: 'SINGLE_SESSION' }
  | { allow: false; reason: 'ZERO_SESSIONS' | 'MULTI_SESSION' | 'REQUIRES_OUTCOME' };

export function directTaskCompletePolicy(
  blocks: SessionEvidenceBlock[],
  opts?: { definitionOfDone?: string | null },
): DirectTaskCompletePolicy {
  if (taskRequiresOutcomeConfirm(opts?.definitionOfDone)) {
    return { allow: false, reason: 'REQUIRES_OUTCOME' };
  }
  const count = activeSessions(blocks).length;
  if (count === 0) return { allow: false, reason: 'ZERO_SESSIONS' };
  if (count === 1) return { allow: true, mode: 'SINGLE_SESSION' };
  return { allow: false, reason: 'MULTI_SESSION' };
}

export const MAX_REPEAT_WEEKS = 52;
/** ~3 calendar months in days for Maintain/Habit materialization. */
export const MAINTAIN_REPEAT_HORIZON_DAYS = 92;

export type RepeatCadence = 'WEEKLY' | 'DAILY';

export function resolveRepeatWeekCount(input: {
  weeks?: number | null;
  untilEpochMs?: number | null;
  fromEpochMs: number;
}): number {
  if (input.weeks != null && Number.isFinite(input.weeks)) {
    return Math.max(1, Math.min(MAX_REPEAT_WEEKS, Math.floor(input.weeks)));
  }
  if (input.untilEpochMs != null && Number.isFinite(input.untilEpochMs)) {
    const ms = input.untilEpochMs - input.fromEpochMs;
    if (ms <= 0) return 1;
    const weeks = Math.ceil(ms / (7 * 86_400_000));
    return Math.max(1, Math.min(MAX_REPEAT_WEEKS, weeks));
  }
  return 8;
}

/**
 * Maintain/Habit horizon: MIN(goal deadline, now + ~3 months).
 * Unlinked Projects / Goals without deadline → now + 3 months.
 */
export function resolveMaintainRepeatUntilEpochMs(input: {
  nowEpochMs: number;
  goalTargetDateEpochMs?: number | null;
}): number {
  const threeMonths = input.nowEpochMs + MAINTAIN_REPEAT_HORIZON_DAYS * 86_400_000;
  if (
    input.goalTargetDateEpochMs != null
    && Number.isFinite(input.goalTargetDateEpochMs)
    && input.goalTargetDateEpochMs > input.nowEpochMs
    && input.goalTargetDateEpochMs < threeMonths
  ) {
    return input.goalTargetDateEpochMs;
  }
  return threeMonths;
}

export function resolveRepeatDayCount(input: {
  days?: number | null;
  untilEpochMs?: number | null;
  fromEpochMs: number;
}): number {
  const maxDays = MAINTAIN_REPEAT_HORIZON_DAYS;
  if (input.days != null && Number.isFinite(input.days)) {
    return Math.max(1, Math.min(maxDays, Math.floor(input.days)));
  }
  if (input.untilEpochMs != null && Number.isFinite(input.untilEpochMs)) {
    const ms = input.untilEpochMs - input.fromEpochMs;
    if (ms <= 0) return 1;
    const days = Math.ceil(ms / 86_400_000);
    return Math.max(1, Math.min(maxDays, days));
  }
  return maxDays;
}

/** Offsets in weeks from the source instance (1 = next week). */
export function futureWeekOffsets(weekCount: number): number[] {
  const n = Math.max(1, Math.min(MAX_REPEAT_WEEKS, weekCount));
  return Array.from({ length: n }, (_, index) => index + 1);
}

/** Offsets in days from the source instance (1 = tomorrow). */
export function futureDayOffsets(dayCount: number): number[] {
  const n = Math.max(1, Math.min(MAINTAIN_REPEAT_HORIZON_DAYS, dayCount));
  return Array.from({ length: n }, (_, index) => index + 1);
}

export function shiftEpochByWeeks(epochMs: number, weeks: number) {
  return epochMs + weeks * 7 * 86_400_000;
}

export function shiftEpochByDays(epochMs: number, days: number) {
  return epochMs + days * 86_400_000;
}

export function appendCarryOverNote(existing: string | null | undefined, note: string) {
  const base = (existing ?? '').trim();
  const add = note.trim();
  if (!add) return base;
  if (!base) return add;
  if (base.includes(add)) return base;
  return `${base}\n\n${add}`;
}

export function buildCarryOverNote(progress: {
  completedCount: number;
  activeCount: number;
  progressPercent: number;
}) {
  return `Carried over from previous week. Previous week's task was not completed (${progress.completedCount}/${progress.activeCount} sessions, ${progress.progressPercent}%).`;
}
