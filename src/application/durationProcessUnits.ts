/**
 * DURATION process values in the planner engine are hours.
 * AI historically suggested minutes with unit "min" — convert at the boundary.
 */

const MINUTE_UNITS = new Set(['min', 'mins', 'minute', 'minutes', 'm']);
const HOUR_UNITS = new Set(['h', 'hr', 'hrs', 'hour', 'hours']);

export function isMinuteProcessUnit(unit?: string | null): boolean {
  if (!unit) return false;
  return MINUTE_UNITS.has(unit.trim().toLowerCase());
}

export function isHourProcessUnit(unit?: string | null): boolean {
  if (!unit) return false;
  return HOUR_UNITS.has(unit.trim().toLowerCase());
}

/** Convert a DURATION process target+unit into engine hours with unit "h". */
export function durationProcessToHours(targetValue: number, unit?: string | null): {
  targetValue: number;
  unit: 'h';
} {
  if (!Number.isFinite(targetValue)) {
    return { targetValue: 0, unit: 'h' };
  }
  if (isMinuteProcessUnit(unit)) {
    return {
      targetValue: Math.round((targetValue / 60) * 10) / 10,
      unit: 'h',
    };
  }
  return {
    targetValue: Math.round(targetValue * 10) / 10,
    unit: 'h',
  };
}
