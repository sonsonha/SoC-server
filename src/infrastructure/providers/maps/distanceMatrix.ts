import type { DistanceMatrixProvider, DistanceMatrixRequest } from '../calendar/types.js';

/** Static / haversine-ish estimate for tests and offline. */
export class FakeDistanceMatrixProvider implements DistanceMatrixProvider {
  constructor(private readonly defaultMinutes = 22) {}

  async travelMinutes(req: DistanceMatrixRequest): Promise<number> {
    const dLat = req.destLat - req.originLat;
    const dLng = req.destLng - req.originLng;
    const approxKm = Math.sqrt(dLat * dLat + dLng * dLng) * 111;
    const minutes = Math.round(approxKm * 4 + this.defaultMinutes * 0.3);
    return Math.max(8, Math.min(90, minutes || this.defaultMinutes));
  }
}

export class GoogleDistanceMatrixProvider implements DistanceMatrixProvider {
  private readonly cache = new Map<string, { minutes: number; at: number }>();
  private readonly fallback = new FakeDistanceMatrixProvider();
  private readonly ttlMs = 15 * 60_000;

  constructor(private readonly apiKey: string) {}

  async travelMinutes(req: DistanceMatrixRequest): Promise<number> {
    const key = [
      req.originLat.toFixed(4),
      req.originLng.toFixed(4),
      req.destLat.toFixed(4),
      req.destLng.toFixed(4),
    ].join(':');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.minutes;

    try {
      const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
      url.searchParams.set('origins', `${req.originLat},${req.originLng}`);
      url.searchParams.set('destinations', `${req.destLat},${req.destLng}`);
      url.searchParams.set('mode', 'transit');
      url.searchParams.set('key', this.apiKey);
      if (req.departureEpochMs) {
        url.searchParams.set('departure_time', String(Math.floor(req.departureEpochMs / 1000)));
      }
      const res = await fetch(url);
      if (!res.ok) return this.fallback.travelMinutes(req);
      const data = (await res.json()) as {
        rows?: Array<{
          elements?: Array<{ status?: string; duration?: { value?: number } }>;
        }>;
      };
      const element = data.rows?.[0]?.elements?.[0];
      if (element?.status !== 'OK' || !element.duration?.value) {
        return this.fallback.travelMinutes(req);
      }
      const minutes = Math.ceil(element.duration.value / 60);
      this.cache.set(key, { minutes, at: Date.now() });
      return minutes;
    } catch {
      return this.fallback.travelMinutes(req);
    }
  }
}
