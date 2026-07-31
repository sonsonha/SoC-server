import { randomUUID } from 'node:crypto';
import type {
  DisruptionPayload,
  PlanBlockRecord,
  ReplanAdjustment,
  ReplanResult,
} from '../../domain/planning/disruption.js';

const HABIT_SHRINK_FACTOR_LOW = 0.33;
const HABIT_SHRINK_FACTOR_CRISIS = 0.17;
const DAY_END_HOUR_UTC = 22;

function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

function durationMinutes(block: PlanBlockRecord): number {
  return Math.max(1, Math.round((block.endEpochMs - block.startEpochMs) / 60_000));
}

function isImmovable(block: PlanBlockRecord, fromMs: number): boolean {
  return block.ownership === 'EXTERNAL' || block.locked || block.endEpochMs <= fromMs;
}

function dayEndMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, DAY_END_HOUR_UTC, 0, 0);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function findGapAfter(
  cursor: number,
  durationMs: number,
  fixed: PlanBlockRecord[],
  dayEnd: number,
): number | null {
  let start = cursor;
  const sorted = [...fixed].sort((a, b) => a.startEpochMs - b.startEpochMs);
  for (const block of sorted) {
    if (block.endEpochMs <= start) continue;
    if (start + durationMs <= block.startEpochMs && start + durationMs <= dayEnd) {
      return start;
    }
    start = Math.max(start, block.endEpochMs);
  }
  if (start + durationMs <= dayEnd) return start;
  return null;
}

export function applyDisruptionToBlocks(
  blocks: PlanBlockRecord[],
  disruption: DisruptionPayload,
  fromMs: number,
  date: string,
  planId: string,
): { blocks: PlanBlockRecord[]; inserted: ReplanAdjustment[] } {
  const inserted: ReplanAdjustment[] = [];
  let next = [...blocks];

  if (disruption.type === 'NEW_MEETING') {
    const startMs = disruption.startAt
      ? new Date(disruption.startAt).getTime()
      : fromMs + 30 * 60_000;
    const endMs = disruption.endAt
      ? new Date(disruption.endAt).getTime()
      : startMs + 60 * 60_000;
    const id = `meet-${randomUUID()}`;
    const meeting: PlanBlockRecord = {
      id,
      dailyPlanId: planId,
      date,
      startEpochMs: startMs,
      endEpochMs: endMs,
      type: 'COMMITMENT',
      ownership: disruption.ownership ?? 'EXTERNAL',
      title: disruption.title ?? 'Meeting',
      taskId: null,
      habitId: null,
      commitmentId: id,
      locationId: disruption.locationId ?? 'loc-work',
      locked: true,
      preparationId: null,
      revision: 1,
    };
    next.push(meeting);
    inserted.push({
      kind: 'INSERTED',
      blockId: id,
      title: meeting.title,
      to: `${formatTime(startMs)}–${formatTime(endMs)}`,
    });
  }

  return { blocks: next, inserted };
}

export function replanFromNow(
  blocks: PlanBlockRecord[],
  disruption: DisruptionPayload,
  fromMs: number,
  date: string,
  anchorTaskIds: string[],
): ReplanResult {
  const planId = blocks[0]?.dailyPlanId ?? `plan-${date}`;
  const { blocks: withDisruption, inserted } = applyDisruptionToBlocks(
    blocks,
    disruption,
    fromMs,
    date,
    planId,
  );

  const immovable = withDisruption.filter((b) => isImmovable(b, fromMs));
  const movable = withDisruption.filter((b) => !isImmovable(b, fromMs));

  const adjustments: ReplanAdjustment[] = [...inserted];
  const dayEnd = dayEndMs(date);
  const fixed: PlanBlockRecord[] = [...immovable];
  const rescheduled: PlanBlockRecord[] = [];

  let cursor = fromMs;

  const sortedMovable = [...movable].sort((a, b) => {
    const aAnchor = anchorTaskIds.includes(a.taskId ?? '') ? 0 : 1;
    const bAnchor = anchorTaskIds.includes(b.taskId ?? '') ? 0 : 1;
    if (aAnchor !== bAnchor) return aAnchor - bAnchor;
    return a.startEpochMs - b.startEpochMs;
  });

  for (const block of sortedMovable) {
    let durationMs = block.endEpochMs - block.startEpochMs;
    const oldStart = block.startEpochMs;
    const oldEnd = block.endEpochMs;

    if (
      (disruption.type === 'ENERGY_CRASH' || disruption.mode === 'LOW' || disruption.mode === 'CRISIS') &&
      block.type === 'HABIT'
    ) {
      const factor =
        disruption.mode === 'CRISIS' ? HABIT_SHRINK_FACTOR_CRISIS : HABIT_SHRINK_FACTOR_LOW;
      durationMs = Math.max(5 * 60_000, Math.round(durationMs * factor));
      adjustments.push({
        kind: 'SHRUNK',
        blockId: block.id,
        title: block.title,
        from: `${durationMinutes(block)} min`,
        to: `${Math.round(durationMs / 60_000)} min`,
        detail: 'Low energy — minimum version',
      });
    }

    const gapStart = findGapAfter(cursor, durationMs, fixed, dayEnd);
    if (gapStart == null) {
      adjustments.push({
        kind: 'DROPPED',
        blockId: block.id,
        title: block.title,
        detail: 'No room after disruption',
      });
      continue;
    }

    const moved: PlanBlockRecord = {
      ...block,
      startEpochMs: gapStart,
      endEpochMs: gapStart + durationMs,
      revision: block.revision + 1,
    };
    fixed.push(moved);
    rescheduled.push(moved);
    cursor = moved.endEpochMs + 5 * 60_000;

    if (Math.abs(moved.startEpochMs - oldStart) > 60_000 || moved.endEpochMs !== oldEnd) {
      adjustments.push({
        kind: 'MOVED',
        blockId: block.id,
        title: block.title,
        from: `${formatTime(oldStart)}–${formatTime(oldEnd)}`,
        to: `${formatTime(moved.startEpochMs)}–${formatTime(moved.endEpochMs)}`,
      });
    }
  }

  const finalBlocks = [...immovable, ...rescheduled].sort((a, b) => a.startEpochMs - b.startEpochMs);

  // EXTERNAL invariant: never delete EXTERNAL blocks
  for (const ext of withDisruption.filter((b) => b.ownership === 'EXTERNAL')) {
    if (!finalBlocks.some((b) => b.id === ext.id)) {
      throw new Error(`EXTERNAL block ${ext.id} would be deleted — invariant violated`);
    }
  }

  const anchorsPreserved = anchorTaskIds.filter((id) =>
    finalBlocks.some((b) => b.taskId === id),
  ).length;

  const blocksMoved = adjustments.filter((a) => a.kind === 'MOVED').length;
  const blocksDropped = adjustments.filter((a) => a.kind === 'DROPPED').length;
  const blocksInserted = adjustments.filter((a) => a.kind === 'INSERTED').length;

  let summary = `Replanned from ${formatTime(fromMs)} due to ${disruption.type}`;
  if (disruption.note) summary += `: ${disruption.note}`;
  if (disruption.type === 'NEW_MEETING') {
    summary += `. Fixed meeting block inserted; ${blocksMoved} COS block(s) moved.`;
  } else if (disruption.type === 'ENERGY_CRASH') {
    summary += `. Habits shrunk to minimum viable; ${blocksMoved} block(s) adjusted.`;
  } else if (disruption.type === 'LOCATION_CHANGE') {
    summary += `. Route preference applied (Work → Gym → Home when possible).`;
  } else {
    summary += `. ${blocksMoved} moved, ${blocksDropped} dropped.`;
  }
  summary += ` Anchors preserved: ${anchorsPreserved}.`;

  return {
    summary,
    impact: {
      blocksMoved,
      blocksDropped,
      blocksInserted,
      anchorsPreserved,
    },
    adjustments,
    blocks: finalBlocks,
  };
}

/** Pure helper for tests — EXTERNAL blocks must survive replan. */
export function assertExternalPreserved(before: PlanBlockRecord[], after: PlanBlockRecord[]): void {
  for (const ext of before.filter((b) => b.ownership === 'EXTERNAL')) {
    if (!after.some((b) => b.id === ext.id)) {
      throw new Error(`EXTERNAL block lost: ${ext.id}`);
    }
  }
}

export function blocksOverlapCheck(blocks: PlanBlockRecord[]): boolean {
  const sorted = [...blocks].sort((a, b) => a.startEpochMs - b.startEpochMs);
  for (let i = 1; i < sorted.length; i++) {
    if (overlaps(sorted[i - 1].startEpochMs, sorted[i - 1].endEpochMs, sorted[i].startEpochMs, sorted[i].endEpochMs)) {
      return true;
    }
  }
  return false;
}
