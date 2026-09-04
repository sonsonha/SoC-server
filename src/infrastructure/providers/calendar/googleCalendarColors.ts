/**
 * Google Calendar event colors are a fixed palette (colorId "1"–"11").
 * Arbitrary hex from Personal OS cannot be sent; we approximate by priority.
 *
 * @see https://developers.google.com/calendar/api/v3/reference/colors
 */
export type GoogleEventColorId =
  | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | '11';

export type PriorityLike = 'P1' | 'P2' | 'P3' | 'P4' | 'HIGH' | 'NORMAL' | 'LOW' | 'DROP' | 1 | 2 | 3 | 4;

/** Do now → Tomato, Important → Blueberry, Delegate → Basil, Drop → Banana */
const PRIORITY_TO_COLOR: Record<'P1' | 'P2' | 'P3' | 'P4', GoogleEventColorId> = {
  P1: '11',
  P2: '9',
  P3: '10',
  P4: '5',
};

const HEX_TO_COLOR: Array<{ hex: string; colorId: GoogleEventColorId }> = [
  { hex: '#dc2626', colorId: '11' },
  { hex: '#ef4444', colorId: '11' },
  { hex: '#fa5d73', colorId: '11' },
  { hex: '#b91c1c', colorId: '11' },
  { hex: '#2563eb', colorId: '9' },
  { hex: '#3b82f6', colorId: '9' },
  { hex: '#3478f6', colorId: '9' },
  { hex: '#1d4ed8', colorId: '9' },
  { hex: '#16a34a', colorId: '10' },
  { hex: '#22c55e', colorId: '10' },
  { hex: '#15803d', colorId: '10' },
  { hex: '#ca8a04', colorId: '5' },
  { hex: '#eab308', colorId: '5' },
  { hex: '#f3a712', colorId: '5' },
  { hex: '#a16207', colorId: '5' },
  { hex: '#705cf6', colorId: '3' },
  { hex: '#4f46e5', colorId: '3' },
  { hex: '#11b8c7', colorId: '7' },
  { hex: '#0891b2', colorId: '7' },
];

export function normalizePlannerPriority(value: PriorityLike | null | undefined): 'P1' | 'P2' | 'P3' | 'P4' {
  if (value === 1 || value === 'P1' || value === 'HIGH') return 'P1';
  if (value === 3 || value === 'P3' || value === 'LOW') return 'P3';
  if (value === 4 || value === 'P4' || value === 'DROP') return 'P4';
  return 'P2';
}

export function googleEventColorIdFromPriority(
  priority: PriorityLike | null | undefined,
): GoogleEventColorId {
  return PRIORITY_TO_COLOR[normalizePlannerPriority(priority)];
}

export function googleEventColorIdFromHex(color: string | null | undefined): GoogleEventColorId | undefined {
  if (!color) return undefined;
  const normalized = color.trim().toLowerCase();
  const hit = HEX_TO_COLOR.find((entry) => entry.hex === normalized);
  return hit?.colorId;
}

/** Prefer task priority; fall back to block hex; default Important/blue. */
export function resolveGoogleEventColorId(input: {
  priority?: PriorityLike | null;
  color?: string | null;
}): GoogleEventColorId {
  if (input.priority != null) return googleEventColorIdFromPriority(input.priority);
  return googleEventColorIdFromHex(input.color) ?? '9';
}
