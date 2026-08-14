import type { CalendarEvent, CalendarProvider } from './types.js';

/** In-memory calendar for tests / USE_FAKE_PROVIDERS. Never mutates seeded EXTERNAL events on COS write. */
export class FakeCalendarProvider implements CalendarProvider {
  private external: CalendarEvent[] = [];
  private cos = new Map<string, CalendarEvent>();

  seed(events: CalendarEvent[]): void {
    this.external = [...events];
  }

  clear(): void {
    this.external = [];
    this.cos.clear();
  }

  async listEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]> {
    return this.external.filter((e) => e.startEpochMs < toEpochMs && e.endEpochMs > fromEpochMs);
  }

  async listCosEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]> {
    return [...this.cos.values()].filter(
      (e) => e.startEpochMs < toEpochMs && e.endEpochMs > fromEpochMs,
    );
  }

  async upsertCosEvent(
    event: Omit<CalendarEvent, 'eventId'> & { eventId?: string },
  ): Promise<string> {
    const id = event.eventId ?? `cos-${event.startEpochMs}`;
    this.cos.set(id, { ...event, eventId: id });
    return id;
  }

  async deleteCosEvent(eventId: string): Promise<void> {
    this.cos.delete(eventId);
  }

  cosEvents(): Map<string, CalendarEvent> {
    return new Map(this.cos);
  }

  externalEvents(): CalendarEvent[] {
    return [...this.external];
  }
}
