/**
 * Session-evidence rules: Task progress/completion derives from TimeBlock sessions.
 * Pure helpers — no DB access.
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
  /** UI hint; persisted Task status is only DONE when all sessions complete. */
  progressState: 'UNSCHEDULED' | 'NOT_STARTED' | 'PARTIAL' | 'DONE';
  /** Derived DB status for the Task. */
  derivedTaskStatus: 'INBOX' | 'SCHEDULED' | 'DONE';
};

export function isSessionDone(status: string | null | undefined) {
  const value = (status ?? '').toUpperCase();
  return value === 'DONE' || value === 'COMPLETED';
}

export function activeSessions(blocks: SessionEvidenceBlock[]) {
  return blocks.filter((block) => !block.deletedAt);
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
 * (implementation must still mark that Session DONE first).
 * Zero or many Sessions: reject direct Task completion.
 */
export type DirectTaskCompletePolicy =
  | { allow: true; mode: 'SINGLE_SESSION' }
  | { allow: false; reason: 'ZERO_SESSIONS' | 'MULTI_SESSION' };

export function directTaskCompletePolicy(
  blocks: SessionEvidenceBlock[],
): DirectTaskCompletePolicy {
  const count = activeSessions(blocks).length;
  if (count === 0) return { allow: false, reason: 'ZERO_SESSIONS' };
  if (count === 1) return { allow: true, mode: 'SINGLE_SESSION' };
  return { allow: false, reason: 'MULTI_SESSION' };
}

export const MAX_REPEAT_WEEKS = 52;

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

/** Offsets in weeks from the source instance (1 = next week). Includes the range length. */
export function futureWeekOffsets(weekCount: number): number[] {
  const n = Math.max(1, Math.min(MAX_REPEAT_WEEKS, weekCount));
  return Array.from({ length: n }, (_, index) => index + 1);
}

export function shiftEpochByWeeks(epochMs: number, weeks: number) {
  return epochMs + weeks * 7 * 86_400_000;
}

export function appendCarryOverNote(
  existingNotes: string | null | undefined,
  carryOverNote: string,
) {
  const base = (existingNotes ?? '').trim();
  const note = carryOverNote.trim();
  if (!note) return base;
  if (!base) return note;
  if (base.includes(note)) return base;
  return `${base}\n\n${note}`;
}

export function buildCarryOverNote(progress: {
  completedCount: number;
  activeCount: number;
  progressPercent: number;
}) {
  return `Carried over from previous week. Previous week's task was not completed (${progress.completedCount}/${progress.activeCount} sessions, ${progress.progressPercent}%).`;
}
