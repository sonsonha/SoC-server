import type { AppConfig } from '../../../config.js';
import { FakePlacesProvider } from './fakePlacesProvider.js';
import type { PlacesProvider, SocialObjective, VenueCandidate } from './types.js';
import {
  FakeDistanceMatrixProvider,
  GoogleDistanceMatrixProvider,
} from './distanceMatrix.js';
import type { DistanceMatrixProvider } from '../calendar/types.js';

/**
 * Live Google Places adapter — uses Places Text Search when GOOGLE_PLACES_API_KEY is set.
 * Falls back to FakePlacesProvider when key missing or request fails.
 */
export class GooglePlacesProvider implements PlacesProvider {
  private readonly fallback = new FakePlacesProvider();

  constructor(private readonly apiKey: string) {}

  async searchVenues(objective: SocialObjective): Promise<VenueCandidate[]> {
    try {
      const query = [
        objective.cuisine?.join(' ') ?? '',
        objective.occasion,
        objective.area,
        objective.vibe?.join(' ') ?? '',
      ]
        .filter(Boolean)
        .join(' ');
      const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
      url.searchParams.set('query', query);
      url.searchParams.set('key', this.apiKey);
      const res = await fetch(url);
      if (!res.ok) return this.fallback.searchVenues(objective);
      const data = (await res.json()) as {
        results?: Array<{
          place_id: string;
          name: string;
          formatted_address?: string;
          rating?: number;
          geometry?: { location?: { lat?: number; lng?: number } };
          opening_hours?: { open_now?: boolean };
          types?: string[];
        }>;
      };
      const results = data.results ?? [];
      if (results.length === 0) return this.fallback.searchVenues(objective);
      return results.slice(0, 8).map((r) => ({
        placeId: r.place_id,
        title: r.name,
        address: r.formatted_address ?? objective.area,
        mapsUrl: `https://maps.google.com/?q=place_id:${r.place_id}`,
        rating: r.rating ?? 0,
        openAtTarget: r.opening_hours?.open_now !== false,
        hoursSummary: r.opening_hours?.open_now === false ? 'Possibly closed' : 'Hours via Places',
        cuisineTags: objective.cuisine ?? [],
        vibeTags: objective.vibe ?? [],
        provider: 'google-places',
        travelMinutesEstimate: 25,
        lat: r.geometry?.location?.lat,
        lng: r.geometry?.location?.lng,
      }));
    } catch {
      return this.fallback.searchVenues(objective);
    }
  }

  async isOpenAt(placeId: string, datetime: Date): Promise<boolean> {
    try {
      const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
      url.searchParams.set('place_id', placeId);
      url.searchParams.set('fields', 'opening_hours');
      url.searchParams.set('key', this.apiKey);
      const res = await fetch(url);
      if (!res.ok) return this.fallback.isOpenAt(placeId, datetime);
      const data = (await res.json()) as {
        result?: { opening_hours?: { open_now?: boolean } };
      };
      return data.result?.opening_hours?.open_now !== false;
    } catch {
      return this.fallback.isOpenAt(placeId, datetime);
    }
  }
}

export function createPlacesProvider(config: AppConfig): PlacesProvider {
  if (config.USE_FAKE_PROVIDERS) return new FakePlacesProvider();
  const key = config.GOOGLE_PLACES_API_KEY ?? config.MAPS_API_KEY;
  if (key) return new GooglePlacesProvider(key);
  return new FakePlacesProvider();
}

export function createDistanceMatrixProvider(config: AppConfig): DistanceMatrixProvider {
  if (config.USE_FAKE_PROVIDERS) return new FakeDistanceMatrixProvider();
  const key = config.MAPS_API_KEY ?? config.GOOGLE_PLACES_API_KEY;
  if (key) return new GoogleDistanceMatrixProvider(key);
  return new FakeDistanceMatrixProvider();
}

export type { PlacesProvider, SocialObjective, VenueCandidate } from './types.js';
export type { DistanceMatrixProvider } from '../calendar/types.js';
export { FakePlacesProvider } from './fakePlacesProvider.js';
export {
  FakeDistanceMatrixProvider,
  GoogleDistanceMatrixProvider,
} from './distanceMatrix.js';
