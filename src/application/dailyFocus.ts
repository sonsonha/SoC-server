/** Daily Focus is scoped to a product planning day (Asia/Ho_Chi_Minh YYYY-MM-DD). */

const PRODUCT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeDailyFocusDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!PRODUCT_DATE_RE.test(trimmed)) {
    throw Object.assign(new Error('dailyFocusDate must be YYYY-MM-DD'), { statusCode: 400 });
  }
  return trimmed;
}

export function isDailyFocusForDate(
  task: { dailyFocusDate?: string | null },
  date: string,
): boolean {
  return Boolean(task.dailyFocusDate && task.dailyFocusDate === date);
}

/**
 * Soft uniqueness: at most one active Daily Focus per user per day.
 * Returns the task that should remain focus after a replacement.
 */
export function resolveDailyFocusReplacement(input: {
  existingFocusTaskId: string | null;
  nextTaskId: string;
}): { clearTaskId: string | null; focusTaskId: string } {
  if (!input.existingFocusTaskId || input.existingFocusTaskId === input.nextTaskId) {
    return { clearTaskId: null, focusTaskId: input.nextTaskId };
  }
  return { clearTaskId: input.existingFocusTaskId, focusTaskId: input.nextTaskId };
}
