/**
 * Manual DeepSeek smoke test — NOT part of deterministic CI.
 *
 * Requires DEEPSEEK_API_KEY. Does NOT persist planner data.
 *
 *   DEEPSEEK_API_KEY=... npm run ai:smoke-goal-structure
 */
import { loadDotEnv } from '../config.js';
import { DeepSeekLlmProvider } from '../infrastructure/providers/llm/deepseekLlmProvider.js';
import {
  GOAL_STRUCTURE_JSON_PROMPT,
  goalStructureSuggestionSchema,
} from '../modules/ai/goalStructureSchema.js';

loadDotEnv();

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    console.error('Set DEEPSEEK_API_KEY to run this smoke test.');
    process.exit(1);
  }
  const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro';
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
    'Title: Get a Backend Developer Job',
    'Target date: 2026-11-30',
  ].join('\n');

  console.log(`Calling DeepSeek model=${model} (no persistence)…`);
  const raw = await provider.structureGoal(prompt);
  const parsed = goalStructureSuggestionSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('FAIL: schema validation', parsed.error.flatten());
    console.error(
      'raw processes sample:',
      JSON.stringify((raw as { processes?: unknown }).processes, null, 2),
    );
    process.exit(1);
  }
  console.log('OK: schema-valid suggestion');
  console.log({
    outcome: parsed.data.outcome?.statement,
    metrics: parsed.data.metrics.length,
    milestones: parsed.data.milestones.length,
    processes: parsed.data.processes.length,
    projects: parsed.data.projects.map((p) => p.title),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
