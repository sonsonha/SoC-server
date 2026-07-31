export type SocialObjective = {
  occasion: string;
  datetime: Date;
  area: string;
  cuisine?: string[];
  vibe?: string[];
  budget?: 'LOW' | 'MID' | 'HIGH';
  partySize?: number;
};

export type VenueCandidate = {
  placeId: string;
  title: string;
  address: string;
  mapsUrl: string;
  rating: number;
  openAtTarget: boolean;
  hoursSummary: string;
  cuisineTags: string[];
  vibeTags: string[];
  provider: string;
  /** Estimated travel minutes from default origin; overridden by travel edges / Distance Matrix */
  travelMinutesEstimate: number;
  lat?: number;
  lng?: number;
};

export interface PlacesProvider {
  searchVenues(objective: SocialObjective): Promise<VenueCandidate[]>;
  /** Re-check whether a venue is open at the given datetime (day-of refresh). */
  isOpenAt(placeId: string, datetime: Date): Promise<boolean>;
}
