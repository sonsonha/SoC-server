import type { PlacesProvider, SocialObjective, VenueCandidate } from './types.js';

const MARINA_BAY_VENUES: VenueCandidate[] = [
  {
    placeId: 'fake-place-odette',
    title: 'Odette — Japanese-inspired fine dining',
    address: '1 St Andrew\'s Rd, #01-04 National Gallery, Singapore 178957',
    mapsUrl: 'https://maps.google.com/?q=Odette+National+Gallery+Singapore',
    rating: 4.8,
    openAtTarget: true,
    hoursSummary: 'Mon–Sat 12:00–14:30, 18:30–22:00',
    cuisineTags: ['japanese', 'fine-dining'],
    vibeTags: ['quiet', 'romantic'],
    provider: 'fake-places',
    travelMinutesEstimate: 25,
  },
  {
    placeId: 'fake-place-sushi-tei',
    title: 'Sushi Tei Marina Bay',
    address: '2 Bayfront Ave, #B2-01 The Shoppes at Marina Bay Sands, Singapore 018972',
    mapsUrl: 'https://maps.google.com/?q=Sushi+Tei+Marina+Bay+Sands',
    rating: 4.2,
    openAtTarget: true,
    hoursSummary: 'Daily 11:30–22:00',
    cuisineTags: ['japanese', 'sushi'],
    vibeTags: ['casual', 'quiet'],
    provider: 'fake-places',
    travelMinutesEstimate: 28,
  },
  {
    placeId: 'fake-place-closed-bar',
    title: 'Closed Bar (test fixture)',
    address: 'Marina Bay, Singapore',
    mapsUrl: 'https://maps.google.com/?q=Closed+Bar+Marina+Bay',
    rating: 4.5,
    openAtTarget: false,
    hoursSummary: 'Closed Fridays',
    cuisineTags: ['japanese'],
    vibeTags: ['quiet'],
    provider: 'fake-places',
    travelMinutesEstimate: 20,
  },
];

const JURONG_CAFES: VenueCandidate[] = [
  {
    placeId: 'fake-place-jurong-cafe',
    title: 'The Coffee Academics Jurong',
    address: '1 Jurong West Central 2, #01-01, Singapore 648886',
    mapsUrl: 'https://maps.google.com/?q=Coffee+Academics+Jurong',
    rating: 4.4,
    openAtTarget: true,
    hoursSummary: 'Daily 08:00–21:00',
    cuisineTags: ['cafe', 'coffee'],
    vibeTags: ['quiet', 'laptop-friendly'],
    provider: 'fake-places',
    travelMinutesEstimate: 35,
  },
  {
    placeId: 'fake-place-jurong-backup',
    title: 'Starbucks Jurong Point',
    address: '1 Jurong West Central 2, Jurong Point, Singapore 648886',
    mapsUrl: 'https://maps.google.com/?q=Starbucks+Jurong+Point',
    rating: 4.0,
    openAtTarget: true,
    hoursSummary: 'Daily 07:00–22:00',
    cuisineTags: ['cafe', 'coffee'],
    vibeTags: ['casual'],
    provider: 'fake-places',
    travelMinutesEstimate: 32,
  },
];

const GENERIC_VENUES: VenueCandidate[] = [
  {
    placeId: 'fake-place-generic-1',
    title: 'Neighborhood Bistro',
    address: 'Singapore',
    mapsUrl: 'https://maps.google.com/?q=Neighborhood+Bistro+Singapore',
    rating: 4.1,
    openAtTarget: true,
    hoursSummary: 'Daily 11:00–22:00',
    cuisineTags: ['international'],
    vibeTags: ['casual'],
    provider: 'fake-places',
    travelMinutesEstimate: 20,
  },
  {
    placeId: 'fake-place-generic-2',
    title: 'Quiet Corner Cafe',
    address: 'Singapore',
    mapsUrl: 'https://maps.google.com/?q=Quiet+Corner+Cafe+Singapore',
    rating: 4.3,
    openAtTarget: true,
    hoursSummary: 'Daily 09:00–20:00',
    cuisineTags: ['cafe'],
    vibeTags: ['quiet'],
    provider: 'fake-places',
    travelMinutesEstimate: 18,
  },
];

/** Test helper: forces a place closed on refresh. */
export class FakePlacesProvider implements PlacesProvider {
  private closedPlaceIds = new Set<string>();

  /** Mark a place closed for isOpenAt (day-of refresh tests). */
  forceClosed(placeId: string): void {
    this.closedPlaceIds.add(placeId);
  }

  async searchVenues(objective: SocialObjective): Promise<VenueCandidate[]> {
    const area = objective.area.toLowerCase();
    const occasion = objective.occasion.toLowerCase();
    let pool =
      area.includes('marina') || occasion.includes('japanese') || occasion.includes('date')
        ? MARINA_BAY_VENUES
        : area.includes('jurong') || occasion.includes('coffee') || occasion.includes('cafe')
          ? JURONG_CAFES
          : GENERIC_VENUES;

    return pool.map((v) => ({
      ...v,
      openAtTarget: this.closedPlaceIds.has(v.placeId) ? false : v.openAtTarget,
    }));
  }

  async isOpenAt(placeId: string, _datetime: Date): Promise<boolean> {
    if (this.closedPlaceIds.has(placeId)) return false;
    if (placeId === 'fake-place-closed-bar') return false;
    return true;
  }
}
