import { z } from 'zod';

export const aiConfidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);

/** AI suggestion schema — maps into existing Goal/Process/Project domain on accept. */
export const goalStructureSuggestionSchema = z.object({
  outcome: z
    .object({
      statement: z.string().trim().min(1).max(2_000),
      confidence: aiConfidenceSchema,
    })
    .optional(),
  metrics: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(240),
        metricType: z.enum([
          'COUNT',
          'DURATION',
          'NUMBER',
          'BOOLEAN',
          'PERCENTAGE',
          'CUSTOM',
        ]),
        currentValue: z.number().nullable().optional(),
        targetValue: z.number().nullable().optional(),
        unit: z.string().max(64).nullable().optional(),
        rationale: z.string().max(2_000).optional(),
        confidence: aiConfidenceSchema,
        needsUserDecision: z.boolean().optional(),
        possibleAlternatives: z.array(z.string().max(240)).max(8).optional(),
      }),
    )
    .max(6)
    .default([]),
  milestones: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(240),
        description: z.string().max(2_000).optional(),
        rationale: z.string().max(2_000).optional(),
      }),
    )
    .max(12)
    .default([]),
  processes: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(240),
        metricType: z.enum(['COUNT', 'DURATION']),
        targetValue: z.number().nonnegative(),
        period: z.literal('WEEK'),
        unit: z.string().max(32).optional(),
        rationale: z.string().max(2_000).optional(),
        confidence: aiConfidenceSchema,
      }),
    )
    .max(8)
    .default([]),
  projects: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(240),
        purpose: z.string().max(2_000).optional(),
        suggestedDefaultProcessName: z.string().max(240).nullable().optional(),
        rationale: z.string().max(2_000).optional(),
      }),
    )
    .min(1)
    .max(8),
  timeProtectedMinutesPerWeek: z.number().int().nonnegative().nullable().optional(),
  nextActions: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(240),
        estimatedMinutes: z.number().int().positive().nullable().optional(),
        projectTitle: z.string().max(240).nullable().optional(),
      }),
    )
    .max(12)
    .default([]),
  reviewCadence: z.enum(['WEEKLY', 'MONTHLY', 'MILESTONE']).optional(),
  assumptions: z.array(z.string().max(1_000)).max(12).default([]),
  questionsForUser: z.array(z.string().max(1_000)).max(12).optional(),
});

export type GoalStructureSuggestion = z.infer<typeof goalStructureSuggestionSchema>;

export const GOAL_STRUCTURE_JSON_PROMPT = `You are a Personal OS Goal structuring assistant.
Return JSON only matching the schema described below. No markdown. No chat.

Personal OS semantics (do not collapse):
- Goal = outcome to make true
- Milestone = meaningful state / checkpoint
- Process = repeated weekly behavior (measurable)
- Project = finite body of work linked to the Goal
- Task = concrete executable next action

Rules:
- Prefer few meaningful processes (1–4) and few projects (1–4).
- Prefer 3–7 milestones.
- Do not invent false precision. If metric is unclear, set needsUserDecision=true and list possibleAlternatives.
- Use confidence HIGH|MEDIUM|LOW honestly.
- Avoid duplicate projects already listed in CURRENT PLANNER CONTEXT.
- Avoid overplanning and generic motivational advice.
- Projects array is REQUIRED (at least one).
- Process metricType is COUNT or DURATION only; period is always WEEK.
- Map DURATION units to minutes when possible (e.g. 3h → targetValue 180, unit "min").

JSON shape:
{
  "outcome": { "statement": string, "confidence": "HIGH"|"MEDIUM"|"LOW" },
  "metrics": [{
    "name": string,
    "metricType": "COUNT"|"DURATION"|"NUMBER"|"BOOLEAN"|"PERCENTAGE"|"CUSTOM",
    "currentValue": number|null,
    "targetValue": number|null,
    "unit": string|null,
    "rationale": string,
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "needsUserDecision": boolean,
    "possibleAlternatives": string[]
  }],
  "milestones": [{ "title": string, "description"?: string, "rationale"?: string }],
  "processes": [{
    "name": string,
    "metricType": "COUNT"|"DURATION",
    "targetValue": number,
    "period": "WEEK",
    "unit"?: string,
    "rationale"?: string,
    "confidence": "HIGH"|"MEDIUM"|"LOW"
  }],
  "projects": [{
    "title": string,
    "purpose"?: string,
    "suggestedDefaultProcessName"?: string|null,
    "rationale"?: string
  }],
  "timeProtectedMinutesPerWeek": number|null,
  "nextActions": [{ "title": string, "estimatedMinutes"?: number|null, "projectTitle"?: string|null }],
  "reviewCadence": "WEEKLY"|"MONTHLY"|"MILESTONE",
  "assumptions": string[],
  "questionsForUser": string[]
}`;
