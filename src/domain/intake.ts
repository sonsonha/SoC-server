import { z } from 'zod';

export const intakePersonSchema = z.object({
  name: z.string().min(1),
  relationship: z.string().nullish(),
});

export const intakeWaitingItemSchema = z.object({
  title: z.string().min(1),
  waitingOn: z.string().nullish(),
  followUpDays: z.number().int().positive().max(90).nullish(),
});

export const intakeDecisionOptionSchema = z.object({
  label: z.string().min(1),
  pros: z.string().nullish(),
  cons: z.string().nullish(),
});

export const intakeTaskSchema = z.object({
  title: z.string().min(1),
  status: z.enum(['TODO', 'WAITING']).nullish(),
});

export const intakeInterpretationSchema = z.object({
  kind: z.enum([
    'LEARNING',
    'TASK',
    'WAITING',
    'DECISION',
    'OPPORTUNITY_RESEARCH',
    'EXPLORATION',
    'SOCIAL',
    'UNKNOWN',
  ]),
  title: z.string().min(1),
  lifeArea: z.string().min(1),
  estimatedMinutes: z.number().int().positive().max(480).nullish(),
  learningTitle: z.string().nullish(),
  needsConfirm: z.boolean(),
  person: intakePersonSchema.nullish(),
  waitingItem: intakeWaitingItemSchema.nullish(),
  task: intakeTaskSchema.nullish(),
  decisionContext: z.string().nullish(),
  decisionOptions: z.array(intakeDecisionOptionSchema).nullish(),
  deadlineHint: z.string().nullish(),
  opportunityId: z.string().nullish(),
  opportunityTitle: z.string().nullish(),
  explorationQuestion: z.string().nullish(),
  socialOccasion: z.string().nullish(),
  socialArea: z.string().nullish(),
  socialCuisine: z.array(z.string()).nullish(),
  socialVibe: z.array(z.string()).nullish(),
  socialDatetimeHint: z.string().nullish(),
});

export type IntakeInterpretationDto = z.infer<typeof intakeInterpretationSchema>;

export const intakeRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  // Android kotlinx may send explicit nulls for unset optionals.
  capturedAt: z.string().datetime().nullish(),
  locationId: z.string().nullish(),
});

export type IntakeRequest = z.infer<typeof intakeRequestSchema>;

export const clarifyAnswerSchema = z.object({
  field: z.enum([
    'commute_home_work_minutes',
    'usual_leave_home',
    'chapter',
    'preferred_countries',
    'skill_domain',
    'skill_level',
  ]),
  value: z.string().min(1).max(500),
});

export const clarifyRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  capturedAt: z.string().datetime().nullish(),
  locationId: z.string().nullish(),
  inboxItemId: z.string().nullish(),
  answers: z.array(clarifyAnswerSchema).min(1),
});

export type ClarifyRequest = z.infer<typeof clarifyRequestSchema>;
