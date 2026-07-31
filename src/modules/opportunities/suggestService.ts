import type { Db } from '../../infrastructure/db/client.js';
import { opportunities } from '../../infrastructure/db/schema/index.js';
import { getActiveProfile } from '../../application/syncService.js';
import type { SearchProvider } from '../../infrastructure/providers/search/types.js';
import { isNull } from 'drizzle-orm';

export type OpportunitySuggestion = {
  id: string;
  title: string;
  description: string;
  deadlineEpochMs: number | null;
  score: number;
  reasons: string[];
  source: 'profile' | 'search';
};

/**
 * Score existing opportunities against profile chapter/goals/skills;
 * optionally invent search-backed suggestions when APPLYING_ABROAD.
 */
export class OpportunitySuggestService {
  constructor(
    private readonly db: Db,
    private readonly search: SearchProvider,
  ) {}

  async suggest(): Promise<OpportunitySuggestion[]> {
    const profile = await getActiveProfile(this.db);
    const rows = await this.db.select().from(opportunities).where(isNull(opportunities.deletedAt));
    const active = rows.filter((o) => o.active);

    const goalText = profile.goals.map((g) => g.title.toLowerCase()).join(' ');
    const skillText = profile.skills.map((s) => s.domain.toLowerCase()).join(' ');
    const chapter = profile.profile?.chapter ?? 'WORKING';
    let countries: string[] = [];
    try {
      countries = JSON.parse(profile.profile?.preferredCountries ?? '[]') as string[];
    } catch {
      countries = [];
    }

    const scored: OpportunitySuggestion[] = active.map((o) => {
      const hay = `${o.title} ${o.description}`.toLowerCase();
      let score = 1;
      const reasons: string[] = [];
      if (chapter === 'APPLYING_ABROAD' && /fellowship|scholarship|abroad|fulbright|nsf/i.test(hay)) {
        score += 5;
        reasons.push('chapter=APPLYING_ABROAD');
      }
      if (goalText && goalText.split(/\s+/).some((w) => w.length > 3 && hay.includes(w))) {
        score += 3;
        reasons.push('matches goal keywords');
      }
      if (skillText && skillText.split(/\s+/).some((w) => w.length > 3 && hay.includes(w))) {
        score += 2;
        reasons.push('matches skills');
      }
      if (countries.some((c) => hay.includes(c.toLowerCase()))) {
        score += 2;
        reasons.push('matches preferred country');
      }
      if (o.deadlineEpochMs && o.deadlineEpochMs > Date.now()) {
        const days = (o.deadlineEpochMs - Date.now()) / 86_400_000;
        if (days <= 60) {
          score += 2;
          reasons.push('deadline within 60 days');
        }
      }
      if (reasons.length === 0) reasons.push('active opportunity');
      return {
        id: o.id,
        title: o.title,
        description: o.description,
        deadlineEpochMs: o.deadlineEpochMs,
        score,
        reasons,
        source: 'profile' as const,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    // When applying abroad and few hits, add search-backed titles (not auto-created).
    if (chapter === 'APPLYING_ABROAD' && scored.filter((s) => s.score >= 4).length < 2) {
      const topic =
        countries[0] ??
        profile.goals.find((g) => g.horizon === 'LONG')?.title ??
        'graduate fellowship';
      try {
        const candidates = await this.search.search({
          query: `${topic} scholarship fellowship official eligibility`,
          topic,
          timeBudgetMinutes: 45,
          preferredFormats: ['ARTICLE'],
        });
        for (const c of candidates.slice(0, 2)) {
          scored.push({
            id: `suggest-${Buffer.from(c.url).toString('base64url').slice(0, 12)}`,
            title: c.title,
            description: c.snippet,
            deadlineEpochMs: null,
            score: 4,
            reasons: ['search suggestion — confirm before preparing'],
            source: 'search',
          });
        }
      } catch {
        // ignore search failures
      }
    }

    return scored.slice(0, 8);
  }
}
