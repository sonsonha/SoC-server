export type CalendarEvent = {
  eventId: string;
  title: string;
  startEpochMs: number;
  endEpochMs: number;
  location?: string | null;
  calendarId?: string;
};

export interface CalendarProvider {
  listEvents(fromEpochMs: number, toEpochMs: number): Promise<CalendarEvent[]>;
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
