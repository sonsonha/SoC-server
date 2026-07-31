import { eq } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import {
  GLOBAL_PREFERENCE_ID,
  resourcePreferences,
  type PreferenceWeights,
} from '../../infrastructure/db/schema/resourcePreferences.js';
import type { FeedbackReason } from '../../domain/feedback.js';

const DEFAULT_WEIGHTS: PreferenceWeights = {
  formatWeights: { ARTICLE: 1, VIDEO: 1, DOC: 1 },
  maxDurationMinutes: null,
  avoidProviders: [],
  penalizeLongForm: false,
  penalizeVideo: false,
};

function parseMaxMinutesFromNote(note?: string): number | null {
  if (!note) return null;
  const m = note.match(/(\d+)\s*(?:min(?:ute)?s?|m\b)/i);
  if (m) return Math.min(180, Math.max(5, Number(m[1])));
  if (/under\s*20|less than 20/i.test(note)) return 20;
  return null;
}

export class PreferenceService {
  constructor(private readonly db: Db) {}

  async getWeights(): Promise<PreferenceWeights> {
    const rows = await this.db
      .select()
      .from(resourcePreferences)
      .where(eq(resourcePreferences.id, GLOBAL_PREFERENCE_ID))
      .limit(1);
    const row = rows[0];
    if (!row) return { ...DEFAULT_WEIGHTS };
    return { ...DEFAULT_WEIGHTS, ...row.weights };
  }

  async ensureGlobalRow(): Promise<void> {
    const rows = await this.db
      .select()
      .from(resourcePreferences)
      .where(eq(resourcePreferences.id, GLOBAL_PREFERENCE_ID))
      .limit(1);
    if (rows[0]) return;
    const now = new Date();
    await this.db.insert(resourcePreferences).values({
      id: GLOBAL_PREFERENCE_ID,
      weights: DEFAULT_WEIGHTS,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
  }

  async applyFeedback(reason: FeedbackReason, note?: string): Promise<PreferenceWeights> {
    await this.ensureGlobalRow();
    const current = await this.getWeights();
    const next: PreferenceWeights = {
      ...current,
      formatWeights: { ...current.formatWeights },
      avoidProviders: [...(current.avoidProviders ?? [])],
    };

    switch (reason) {
      case 'TOO_LONG':
        next.penalizeLongForm = true;
        const maxFromNote = parseMaxMinutesFromNote(note);
        if (maxFromNote != null) {
          next.maxDurationMinutes = maxFromNote;
        } else if (next.maxDurationMinutes == null) {
          next.maxDurationMinutes = 20;
        } else {
          next.maxDurationMinutes = Math.min(next.maxDurationMinutes, 20);
        }
        break;
      case 'TOO_SHORT':
        next.maxDurationMinutes = null;
        next.penalizeLongForm = false;
        break;
      case 'WRONG_FORMAT':
        next.penalizeVideo = true;
        next.formatWeights = {
          ...next.formatWeights,
          VIDEO: (next.formatWeights?.VIDEO ?? 1) - 2,
          ARTICLE: (next.formatWeights?.ARTICLE ?? 1) + 1,
        };
        break;
      case 'PAYWALL':
      case 'LOW_QUALITY':
        // no global weight change; per-resource rejection handled in replace
        break;
      default:
        break;
    }

    const now = new Date();
    const rows = await this.db
      .select()
      .from(resourcePreferences)
      .where(eq(resourcePreferences.id, GLOBAL_PREFERENCE_ID))
      .limit(1);
    const revision = (rows[0]?.revision ?? 1) + 1;

    await this.db
      .update(resourcePreferences)
      .set({
        weights: next,
        revision,
        updatedAt: now,
      })
      .where(eq(resourcePreferences.id, GLOBAL_PREFERENCE_ID));

    return next;
  }
}
