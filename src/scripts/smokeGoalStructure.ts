/**
 * Manual DeepSeek smoke test — NOT part of deterministic CI.
 *
 * Requires DEEPSEEK_API_KEY. Does NOT persist planner data.
 *
 *   DEEPSEEK_API_KEY=... npm run ai:smoke-goal-structure
 */
import { randomUUID } from 'node:crypto';
import { loadDotEnv } from '../config.js';
import { DeepSeekLlmProvider } from '../infrastructure/providers/llm/deepseekLlmProvider.js';
import {
  GOAL_STRUCTURE_JSON_PROMPT,
  goalStructureSuggestionSchema,
} from '../modules/ai/goalStructureSchema.js';
import { normalizeGoalStructureSuggestion } from '../modules/ai/normalizeGoalStructureSuggestion.js';
import { formatZodIssuesSafe } from '../modules/ai/goalStructureValidation.js';

loadDotEnv();

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    console.error('Set DEEPSEEK_API_KEY to run this smoke test.');
    process.exit(1);
  }
  const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash';
  const requestId = randomUUID();
  const provider = new DeepSeekLlmProvider(apiKey, model);
  const prompt = [
    GOAL_STRUCTURE_JSON_PROMPT,
    '',
    'USER AI CONTEXT',
    'Software engineer interested in backend roles.',
    '',
    'CURRENT PLANNER CONTEXT',
    'ACTIVE GOALS\n(none)\nACTIVE PROJECTS\n(none)\nCURRENT WEEKLY SYSTEMS\n(none)',
    '',
    'NEW GOAL INPUT',
    'Title: Get a Backend Developer job',
    'Target date: 2026-10-01',
    'Focus type: FOCUS',
  ].join('\n');

  console.log(`Calling DeepSeek model=${model} requestId=${requestId} (no persistence)…`);
  let raw: unknown;
  try {
    raw = await provider.structureGoal(prompt);
  } catch (err) {
    console.error('FAIL: provider/JSON', {
      requestId,
      code: (err as { code?: string }).code,
      message: (err as Error).message,
    });
    process.exit(1);
  }

  console.log('JSON parse: PASS');
  console.log('top-level keys:', raw && typeof raw === 'object' ? Object.keys(raw as object) : typeof raw);

  const normalized = normalizeGoalStructureSuggestion(raw);
  const parsed = goalStructureSuggestionSchema.safeParse(normalized);
  if (!parsed.success) {
    console.error('FAIL: AI_SCHEMA_INVALID', {
      requestId,
      provider: 'deepseek',
      model,
      issues: formatZodIssuesSafe(parsed.error),
    });
    process.exit(1);
  }

  console.log('Zod validation: PASS');
  console.log({
    outcome: parsed.data.outcome ? 'present' : 'absent',
    metrics: parsed.data.metrics.length,
    milestones: parsed.data.milestones.length,
    processes: parsed.data.processes.length,
    projects: parsed.data.projects.length,
    nextActions: parsed.data.nextActions.length,
    validated: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
