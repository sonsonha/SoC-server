import { z } from 'zod';

export const feedbackReasonSchema = z.enum([
  'TOO_LONG',
  'TOO_SHORT',
  'TOO_DIFFICULT',
  'TOO_EASY',
  'WRONG_FORMAT',
  'WRONG_TOPIC',
  'PAYWALL',
  'LOW_QUALITY',
  'OTHER',
]);

export type FeedbackReason = z.infer<typeof feedbackReasonSchema>;

export const feedbackRequestSchema = z.object({
  reason: feedbackReasonSchema,
  note: z.string().max(2000).optional(),
});
