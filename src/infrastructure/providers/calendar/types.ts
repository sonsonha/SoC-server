export type CalendarEvent = {
  eventId: string;
  title: string;
  startEpochMs: number;
  endEpochMs: number;
  location?: string | null;
  calendarId?: string;
  /** True when Google used date-only start/end (all-day). */
  allDay?: boolean;
  /** Private metadata written only on planner-owned event copies. */
  appMetadata?: Record<string, string>;
};

export interface CalendarProvider {
  /**
   * EXTERNAL Google events for capacity/planning.
   * Implementations may aggregate primary + selected/configured calendars.
   * Must never mutate these events.
   */
  listEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]>;
  /** Events from the calendar Personal OS writes to, used for two-way reconciliation. */
  listCosEvents?(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]>;
  /** Write COS-owned event to dedicated calendar. Never mutates EXTERNAL. */
  upsertCosEvent?(
    event: Omit<CalendarEvent, 'eventId'> & { eventId?: string },
  ): Promise<string>;
  /** Delete COS-owned event only. Never deletes EXTERNAL / primary events. */
  deleteCosEvent?(eventId: string): Promise<void>;
}

export type DistanceMatrixRequest = {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  departureEpochMs?: number;
};

export interface DistanceMatrixProvider {
  travelMinutes(req: DistanceMatrixRequest): Promise<number>;
}
