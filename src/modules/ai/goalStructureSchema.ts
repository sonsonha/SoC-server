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
        unit: z.string().max(64).nullish(),
        rationale: z.string().max(2_000).nullish(),
        confidence: aiConfidenceSchema,
        needsUserDecision: z.boolean().optional(),
        possibleAlternatives: z.array(z.string().max(240)).max(8).nullish(),
      }),
    )
    .max(6)
    .default([]),
  milestones: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(240),
        description: z.string().max(2_000).nullish(),
        rationale: z.string().max(2_000).nullish(),
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
        unit: z.string().max(32).nullish(),
        rationale: z.string().max(2_000).nullish(),
        confidence: aiConfidenceSchema,
      }),
    )
    .max(8)
    .default([]),
  projects: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(240),
        purpose: z.string().max(2_000).nullish(),
        suggestedDefaultProcessName: z.string().max(240).nullish(),
        rationale: z.string().max(2_000).nullish(),
      }),
    )
    .min(1)
    .max(8),
  timeProtectedMinutesPerWeek: z.number().int().nonnegative().nullable().optional(),
  nextActions: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(240),
        estimatedMinutes: z.number().int().positive().nullish(),
        projectTitle: z.string().max(240).nullish(),
      }),
    )
    .max(12)
    .default([]),
  reviewCadence: z.enum(['WEEKLY', 'MONTHLY', 'MILESTONE']).nullish(),
  assumptions: z.array(z.string().max(1_000)).max(12).default([]),
  questionsForUser: z.array(z.string().max(1_000)).max(12).nullish(),
});

export type GoalStructureSuggestion = z.infer<typeof goalStructureSuggestionSchema>;

export const GOAL_STRUCTURE_JSON_PROMPT = `You are a Personal OS Goal structuring assistant.
Return ONE JSON object only. No markdown. No chat. No prose outside JSON.

Personal OS semantics — never collapse these concepts:

Goal = outcome to make true (desired end state)
Metric = how that outcome is measured (may need clarification)
Milestone = meaningful checkpoint / state transition toward the outcome
Process / System = repeated measurable weekly behavior
Project = finite body of work that advances the Goal
Task = concrete executable next action

Rules:
- Prefer few meaningful items: 3–7 milestones, 1–4 processes, 1–4 projects.
- Projects array is REQUIRED (at least one).
- Distinguish Processes (repeatable) from Projects (finite).
- Do not invent false precision. If a metric is unclear, set needsUserDecision=true and list possibleAlternatives with a recommended candidate in rationale.
- Use confidence HIGH|MEDIUM|LOW honestly.
- Do not invent personal facts absent from USER AI CONTEXT.
- Avoid duplicate Projects already listed in CURRENT PLANNER CONTEXT.
- Respect existing weekly workload — do not pile on many new systems.
- Avoid generic motivational advice and overplanning.
- Process metricType is COUNT or DURATION only; period is always WEEK.
- For DURATION, use minutes (e.g. 3h → targetValue 180, unit "min"). Optional strings may be omitted or null.
- suggestedDefaultProcessName must exactly match a process name in THIS suggestion when linking.
- Surface uncertainty via assumptions and questionsForUser.

JSON shape:
{
  "outcome": { "statement": string, "confidence": "HIGH"|"MEDIUM"|"LOW" },
  "metrics": [{
    "name": string,
    "metricType": "COUNT"|"DURATION"|"NUMBER"|"BOOLEAN"|"PERCENTAGE"|"CUSTOM",
    "currentValue": number|null,
    "targetValue": number|null,
    "unit": string|null,
    "rationale": string|null,
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "needsUserDecision": boolean,
    "possibleAlternatives": string[]
  }],
  "milestones": [{ "title": string, "description"?: string|null, "rationale"?: string|null }],
  "processes": [{
    "name": string,
    "metricType": "COUNT"|"DURATION",
    "targetValue": number,
    "period": "WEEK",
    "unit"?: string|null,
    "rationale"?: string|null,
    "confidence": "HIGH"|"MEDIUM"|"LOW"
  }],
  "projects": [{
    "title": string,
    "purpose"?: string|null,
    "suggestedDefaultProcessName"?: string|null,
    "rationale"?: string|null
  }],
  "timeProtectedMinutesPerWeek": number|null,
  "nextActions": [{ "title": string, "estimatedMinutes"?: number|null, "projectTitle"?: string|null }],
  "reviewCadence": "WEEKLY"|"MONTHLY"|"MILESTONE",
  "assumptions": string[],
  "questionsForUser": string[]
}`;
