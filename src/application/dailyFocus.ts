/**
 * Daily Focus is Session-scoped.
 * Local planning day = Asia/Ho_Chi_Minh YYYY-MM-DD derived from Session start.
 */

const PRODUCT_OFFSET_MS = 7 * 60 * 60 * 1000;
const PRODUCT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function productDateFromEpoch(epochMs: number): string {
  const shifted = new Date(epochMs + PRODUCT_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function normalizeDailyFocusDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!PRODUCT_DATE_RE.test(trimmed)) {
    throw Object.assign(new Error('dailyFocusDate must be YYYY-MM-DD'), { statusCode: 400 });
  }
  return trimmed;
}

/** @deprecated Task-level Daily Focus — prefer Session isDailyFocus. */
export function isDailyFocusForDate(
  task: { dailyFocusDate?: string | null },
  date: string,
): boolean {
  return Boolean(task.dailyFocusDate && task.dailyFocusDate === date);
}

export function isSessionDailyFocusOnDate(
  session: { isDailyFocus?: boolean | null; startEpochMs: number },
  date: string,
): boolean {
  return Boolean(session.isDailyFocus) && productDateFromEpoch(session.startEpochMs) === date;
}

export function findDailyFocusSession<
  T extends { id: string; isDailyFocus?: boolean | null; startEpochMs: number },
>(sessions: T[], date: string): T | null {
  return sessions.find((session) => isSessionDailyFocusOnDate(session, date)) ?? null;
}

/**
 * Soft uniqueness: at most one active Daily Focus Session per user per local day.
 */
export function resolveSessionDailyFocusReplacement(input: {
  existingFocusSessionId: string | null;
  nextSessionId: string;
}): { clearSessionId: string | null; focusSessionId: string } {
  if (!input.existingFocusSessionId || input.existingFocusSessionId === input.nextSessionId) {
    return { clearSessionId: null, focusSessionId: input.nextSessionId };
  }
  return { clearSessionId: input.existingFocusSessionId, focusSessionId: input.nextSessionId };
}

/** @deprecated Prefer resolveSessionDailyFocusReplacement. */
export function resolveDailyFocusReplacement(input: {
  existingFocusTaskId: string | null;
  nextTaskId: string;
}): { clearTaskId: string | null; focusTaskId: string } {
  if (!input.existingFocusTaskId || input.existingFocusTaskId === input.nextTaskId) {
    return { clearTaskId: null, focusTaskId: input.nextTaskId };
  }
  return { clearTaskId: input.existingFocusTaskId, focusTaskId: input.nextTaskId };
}

/**
 * When moving a focus Session across days:
 * - same day → keep focus
 * - other day empty → keep focus
 * - other day occupied → conflict (caller asks Replace vs demote)
 */
export function resolveFocusOnSessionMove(input: {
  wasDailyFocus: boolean;
  sourceDate: string;
  destDate: string;
  destExistingFocusSessionId: string | null;
  movingSessionId: string;
}):
  | { action: 'KEEP' }
  | { action: 'KEEP_ON_EMPTY_DAY' }
  | { action: 'CONFLICT'; existingFocusSessionId: string }
  | { action: 'NONE' } {
  if (!input.wasDailyFocus) return { action: 'NONE' };
  if (input.sourceDate === input.destDate) return { action: 'KEEP' };
  if (
    !input.destExistingFocusSessionId
    || input.destExistingFocusSessionId === input.movingSessionId
  ) {
    return { action: 'KEEP_ON_EMPTY_DAY' };
  }
  return {
    action: 'CONFLICT',
    existingFocusSessionId: input.destExistingFocusSessionId,
  };
}
