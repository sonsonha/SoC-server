import { describe, expect, it } from 'vitest';
import {
  isPlannerOwnedCalendarEvent,
  plannerBlockReconciliation,
} from './calendarPullService.js';

const event = {
  eventId: 'google-event-1',
  title: 'Focus block',
  startEpochMs: 1_000,
  endEpochMs: 2_000,
  calendarId: 'primary',
};

describe('calendar ownership reconciliation', () => {
  it('recognizes only V2 blocks written by Personal OS as app-owned', () => {
    expect(isPlannerOwnedCalendarEvent({
      ...event,
      appMetadata: { plannerOrigin: 'personal-os', timeBlockId: 'block-1' },
    })).toBe(true);
    expect(isPlannerOwnedCalendarEvent({
      ...event,
      appMetadata: { plannerOrigin: 'personal-os', planBlockId: 'legacy-1' },
    })).toBe(false);
    expect(isPlannerOwnedCalendarEvent(event)).toBe(false);
  });

  it('removes a local block when its owned Google event was deleted', () => {
    expect(plannerBlockReconciliation({
      title: event.title,
      startEpochMs: event.startEpochMs,
      endEpochMs: event.endEpochMs,
      syncStatus: 'SYNCED',
    })).toBe('remove');
  });

  it('updates a local block when the Google copy was moved and otherwise stays stable', () => {
    const block = {
      title: event.title,
      startEpochMs: event.startEpochMs,
      endEpochMs: event.endEpochMs,
      syncStatus: 'SYNCED',
    };
    expect(plannerBlockReconciliation(block, event)).toBe('none');
    expect(plannerBlockReconciliation(block, { ...event, startEpochMs: 1_500 })).toBe('update');
  });
});
