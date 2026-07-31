import { z } from 'zod';

export const learningRecommendationSchema = z.object({
  id: z.string(),
  title: z.string(),
  lifeArea: z.string(),
  topic: z.string(),
  reason: z.string(),
  suggestedTargetPerWeek: z.number().int().min(1).max(7),
  priority: z.number().int().min(1).max(5),
  goalId: z.string().nullish(),
  skillId: z.string().nullish(),
  definitionOfProgress: z.string().optional(),
});

export type LearningRecommendation = z.infer<typeof learningRecommendationSchema>;

export const createTracksBodySchema = z.object({
  recommendationIds: z.array(z.string()).default([]),
  custom: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        lifeArea: z.string().min(1).max(40),
        topic: z.string().min(1).max(300),
        targetPerWeek: z.number().int().min(1).max(7).optional(),
        priority: z.number().int().min(1).max(5).optional(),
        definitionOfProgress: z.string().max(500).optional(),
      }),
    )
    .default([]),
});

export type CreateTracksBody = z.infer<typeof createTracksBodySchema>;
