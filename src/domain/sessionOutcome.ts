/**
 * Session Outcome — optional progress evidence inside one work block.
 * Independent from Session Done (execution) and Task Definition of Done.
 */

import { randomUUID } from 'node:crypto';

export type SessionOutcomeType = 'NONE' | 'CHECKLIST' | 'QUANTITY';

export type SessionOutcomeChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

export type SessionOutcomePayload = {
  type: SessionOutcomeType;
  items: SessionOutcomeChecklistItem[];
  target: number | null;
  actual: number | null;
  unit: string | null;
};

export type SessionOutcomeApi = SessionOutcomePayload & {
  completedCount: number;
  totalCount: number;
  progressLabel: string | null;
};

const OUTCOME_TYPES = new Set<SessionOutcomeType>(['NONE', 'CHECKLIST', 'QUANTITY']);

export function normalizeOutcomeType(value: unknown): SessionOutcomeType {
  const raw = String(value ?? 'NONE').trim().toUpperCase();
  if (OUTCOME_TYPES.has(raw as SessionOutcomeType)) return raw as SessionOutcomeType;
  return 'NONE';
}

export function parseChecklistItems(value: unknown): SessionOutcomeChecklistItem[] {
  if (!Array.isArray(value)) return [];
  const items: SessionOutcomeChecklistItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const text = String(record.text ?? '').trim();
    if (!text) continue;
    const id = String(record.id ?? '').trim() || randomUUID();
    items.push({
      id,
      text,
      done: Boolean(record.done),
    });
  }
  return items;
}

function asNonNegInt(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

export function normalizeSessionOutcome(input: {
  type?: unknown;
  items?: unknown;
  target?: unknown;
  actual?: unknown;
  unit?: unknown;
}): SessionOutcomePayload {
  const type = normalizeOutcomeType(input.type);
  if (type === 'NONE') {
    return { type: 'NONE', items: [], target: null, actual: null, unit: null };
  }
  if (type === 'CHECKLIST') {
    return {
      type: 'CHECKLIST',
      items: parseChecklistItems(input.items),
      target: null,
      actual: null,
      unit: null,
    };
  }
  const target = asNonNegInt(input.target, 0) ?? 0;
  const actual = asNonNegInt(input.actual, 0) ?? 0;
  const unit = String(input.unit ?? '').trim() || null;
  return {
    type: 'QUANTITY',
    items: [],
    target,
    actual,
    unit,
  };
}

export function sessionOutcomeFromRow(row: {
  sessionOutcomeType?: string | null;
  sessionOutcomeItems?: unknown;
  sessionOutcomeTarget?: number | null;
  sessionOutcomeActual?: number | null;
  sessionOutcomeUnit?: string | null;
}): SessionOutcomePayload {
  return normalizeSessionOutcome({
    type: row.sessionOutcomeType,
    items: row.sessionOutcomeItems,
    target: row.sessionOutcomeTarget,
    actual: row.sessionOutcomeActual,
    unit: row.sessionOutcomeUnit,
  });
}

export function sessionOutcomeProgress(outcome: SessionOutcomePayload): {
  completedCount: number;
  totalCount: number;
  progressLabel: string | null;
} {
  if (outcome.type === 'CHECKLIST') {
    const totalCount = outcome.items.length;
    const completedCount = outcome.items.filter((item) => item.done).length;
    return {
      completedCount,
      totalCount,
      progressLabel: totalCount > 0 ? `${completedCount} / ${totalCount}` : null,
    };
  }
  if (outcome.type === 'QUANTITY') {
    const target = outcome.target ?? 0;
    const actual = outcome.actual ?? 0;
    const unit = outcome.unit ? ` ${outcome.unit}` : '';
    return {
      completedCount: actual,
      totalCount: target,
      progressLabel: `${actual} / ${target}${unit}`,
    };
  }
  return { completedCount: 0, totalCount: 0, progressLabel: null };
}

export function serializeSessionOutcome(outcome: SessionOutcomePayload): SessionOutcomeApi {
  const progress = sessionOutcomeProgress(outcome);
  return {
    ...outcome,
    ...progress,
  };
}

/** Merge a partial patch onto the current outcome. */
export function applySessionOutcomePatch(
  current: SessionOutcomePayload,
  patch: Partial<{
    type: unknown;
    items: unknown;
    target: unknown;
    actual: unknown;
    unit: unknown;
  }>,
): SessionOutcomePayload {
  const nextType = patch.type !== undefined
    ? normalizeOutcomeType(patch.type)
    : current.type;
  if (nextType === 'NONE') {
    return normalizeSessionOutcome({ type: 'NONE' });
  }
  if (nextType === 'CHECKLIST') {
    return normalizeSessionOutcome({
      type: 'CHECKLIST',
      items: patch.items !== undefined ? patch.items : current.items,
    });
  }
  return normalizeSessionOutcome({
    type: 'QUANTITY',
    target: patch.target !== undefined ? patch.target : current.target,
    actual: patch.actual !== undefined ? patch.actual : current.actual,
    unit: patch.unit !== undefined ? patch.unit : current.unit,
  });
}

export function checklistItem(text: string, done = false): SessionOutcomeChecklistItem {
  return { id: randomUUID(), text, done };
}
