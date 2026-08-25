/**
 * Isolate Time Protected conversion so AI schema stays numeric minutes
 * while persistence uses the current GoalSystem cadence representation.
 */
export function timeProtectedMinutesToSystemCadence(
  minutes: number | null | undefined,
): { title: string; cadence: string } | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const rounded = Math.round(minutes);
  const cadence =
    rounded % 60 === 0
      ? `${rounded / 60}h / week`
      : `${rounded} min / week`;
  return { title: 'Time protected', cadence };
}
