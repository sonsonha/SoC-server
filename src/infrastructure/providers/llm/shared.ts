import { z } from 'zod';
import { intakeInterpretationSchema } from '../../../domain/intake.js';
import type { IntakeInterpretation } from './types.js';

export const structureSchema = z.object({
  goal: z.string().min(1),
  practicePrompt: z.string().min(1),
  doneCriteria: z.array(z.string().min(1)).min(2),
});

/** Re-export domain intake schema for live LLM providers. */
export const intakeSchema = intakeInterpretationSchema;

/** Strip Zod nullish nulls so result matches IntakeInterpretation. */
export function normalizeIntake(
  parsed: z.infer<typeof intakeInterpretationSchema>,
): IntakeInterpretation {
  return {
    kind: parsed.kind,
    title: parsed.title,
    lifeArea: parsed.lifeArea,
    estimatedMinutes: parsed.estimatedMinutes ?? undefined,
    learningTitle: parsed.learningTitle ?? undefined,
    needsConfirm: parsed.needsConfirm,
    person: parsed.person
      ? {
          name: parsed.person.name,
          relationship: parsed.person.relationship ?? undefined,
        }
      : undefined,
    waitingItem: parsed.waitingItem
      ? {
          title: parsed.waitingItem.title,
          waitingOn: parsed.waitingItem.waitingOn ?? undefined,
          followUpDays: parsed.waitingItem.followUpDays ?? undefined,
        }
      : undefined,
    task: parsed.task
      ? {
          title: parsed.task.title,
          status: parsed.task.status ?? undefined,
        }
      : undefined,
    decisionContext: parsed.decisionContext ?? undefined,
    decisionOptions: parsed.decisionOptions?.map((o) => ({
      label: o.label,
      pros: o.pros ?? undefined,
      cons: o.cons ?? undefined,
    })),
    deadlineHint: parsed.deadlineHint ?? undefined,
    opportunityTitle: parsed.opportunityTitle ?? undefined,
    explorationQuestion: parsed.explorationQuestion ?? undefined,
    socialOccasion: parsed.socialOccasion ?? undefined,
    socialArea: parsed.socialArea ?? undefined,
    socialCuisine: parsed.socialCuisine ?? undefined,
    socialVibe: parsed.socialVibe ?? undefined,
    socialDatetimeHint: parsed.socialDatetimeHint ?? undefined,
  };
}

export const INTAKE_JSON_PROMPT = `You interpret personal assistant intake.
Respond with JSON only matching this shape:
{
  "kind": "LEARNING"|"TASK"|"WAITING"|"DECISION"|"OPPORTUNITY_RESEARCH"|"EXPLORATION"|"SOCIAL"|"UNKNOWN",
  "title": string,
  "lifeArea": string,
  "estimatedMinutes": number (optional),
  "learningTitle": string (optional),
  "needsConfirm": boolean,
  "person": { "name": string, "relationship"?: string } (optional),
  "waitingItem": { "title": string, "waitingOn"?: string, "followUpDays"?: number } (optional),
  "task": { "title": string, "status"?: "TODO"|"WAITING" } (optional),
  "decisionContext": string (optional),
  "decisionOptions": [{ "label": string, "pros"?: string, "cons"?: string }] (optional),
  "deadlineHint": string (optional),
  "opportunityTitle": string (optional),
  "explorationQuestion": string (optional),
  "socialOccasion": string (optional),
  "socialArea": string (optional),
  "socialCuisine": string[] (optional),
  "socialVibe": string[] (optional),
  "socialDatetimeHint": string (optional)
}`;

export function structureJsonPrompt(input: {
  topic: string;
  timeBudgetMinutes: number;
  candidate: { title: string; url: string; snippet: string };
}): string {
  return `Structure a learning session using ONLY this source (do not invent URLs):
Title: ${input.candidate.title}
URL: ${input.candidate.url}
Snippet: ${input.candidate.snippet}
Topic: ${input.topic}
Time budget: ${input.timeBudgetMinutes} minutes

Respond with JSON only: {"goal":"...","practicePrompt":"...","doneCriteria":["...","..."]}`;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    }
    throw new Error('LLM returned non-JSON response');
  }
}
