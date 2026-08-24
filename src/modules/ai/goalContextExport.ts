import type { GoalStructureSuggestion } from './goalStructureSchema.js';

/** Markdown for AI draft review — paste into external ChatGPT. No IDs/secrets. */
export function exportSuggestionMarkdown(opts: {
  title: string;
  why?: string;
  targetDate?: string | null;
  aiContext: string;
  suggestion: GoalStructureSuggestion;
}): string {
  const s = opts.suggestion;
  const lines: string[] = [
    '# Personal OS — AI Goal Structure Draft',
    '',
    '## User Context',
    '',
    opts.aiContext.trim() || '(none)',
    '',
    '## Goal input',
    '',
    `Title: ${opts.title}`,
  ];
  if (opts.why?.trim()) lines.push(`Why: ${opts.why.trim()}`);
  if (opts.targetDate) lines.push(`Target date: ${opts.targetDate}`);
  lines.push('');

  if (s.outcome) {
    lines.push('## Outcome', '', s.outcome.statement, `Confidence: ${s.outcome.confidence}`, '');
  }

  lines.push('## Metrics', '');
  for (const m of s.metrics) {
    lines.push(`### ${m.name}`);
    lines.push(`Type: ${m.metricType}`);
    if (m.currentValue != null || m.targetValue != null) {
      lines.push(`Current: ${m.currentValue ?? '—'} → Target: ${m.targetValue ?? '—'}${m.unit ? ` ${m.unit}` : ''}`);
    }
    if (m.needsUserDecision) lines.push('Needs user decision: yes');
    if (m.possibleAlternatives?.length) {
      lines.push(`Alternatives: ${m.possibleAlternatives.join('; ')}`);
    }
    if (m.rationale) lines.push(`Why: ${m.rationale}`);
    lines.push('');
  }

  lines.push('## Milestones', '');
  for (const m of s.milestones) lines.push(`- ${m.title}`);
  lines.push('');

  lines.push('## Systems / Processes', '');
  for (const p of s.processes) {
    lines.push(`### ${p.name}`);
    lines.push(`${p.targetValue}${p.unit ? ` ${p.unit}` : ''} / week (${p.metricType})`);
    if (p.rationale) lines.push(`Why: ${p.rationale}`);
    lines.push('');
  }

  lines.push('## Projects', '');
  for (const p of s.projects) {
    lines.push(`### ${p.title}`);
    if (p.purpose) lines.push(`Purpose: ${p.purpose}`);
    if (p.suggestedDefaultProcessName) lines.push(`Default process: ${p.suggestedDefaultProcessName}`);
    if (p.rationale) lines.push(`Why: ${p.rationale}`);
    lines.push('');
  }

  if (s.timeProtectedMinutesPerWeek != null) {
    lines.push('## Time Protected', '', `${s.timeProtectedMinutesPerWeek} minutes / week`, '');
  }

  lines.push('## Suggested Next Actions', '');
  for (const a of s.nextActions) {
    const mins = a.estimatedMinutes ? ` (~${a.estimatedMinutes}m)` : '';
    const proj = a.projectTitle ? ` — ${a.projectTitle}` : '';
    lines.push(`- ${a.title}${mins}${proj}`);
  }
  lines.push('');

  if (s.assumptions.length) {
    lines.push('## Assumptions', '');
    for (const a of s.assumptions) lines.push(`- ${a}`);
    lines.push('');
  }

  if (s.questionsForUser?.length) {
    lines.push('## Questions', '');
    for (const q of s.questionsForUser) lines.push(`- ${q}`);
    lines.push('');
  }

  lines.push(
    '## Context for an external AI',
    '',
    'This is a draft suggestion from Personal OS. Help improve it without inventing personal facts.',
    'Distinguish Goal outcome, Metric, Milestone, Process, Project, and Task.',
  );

  return lines.join('\n');
}

export type GoalContextExportInput = {
  aiContext: string;
  goal: {
    title: string;
    focusType?: string | null;
    outcome?: string | null;
    why?: string | null;
    metric?: string | null;
    targetDate?: string | null;
    status?: string | null;
  };
  milestones: Array<{ title: string; status: string }>;
  processes: Array<{
    name: string;
    completed?: number;
    planned?: number;
    target: number;
    unit?: string;
  }>;
  projects: Array<{
    title: string;
    purpose?: string | null;
    nextAction?: string | null;
  }>;
  tasks: Array<{
    title: string;
    dueHorizon?: string | null;
    scheduled: boolean;
    done: boolean;
  }>;
  timeProtectedMinutes?: number | null;
  progress?: {
    consistencyMetWeeks?: number;
    consistencyTotalWeeks?: number;
    insight?: string | null;
  } | null;
  reflection?: string | null;
};

/** Full Goal Markdown for external ChatGPT — no DB IDs, tokens, or calendar IDs. */
export function exportGoalFullContextMarkdown(input: GoalContextExportInput): string {
  const lines: string[] = [
    '# Personal OS Goal Context',
    '',
    '## User Context',
    '',
    input.aiContext.trim() || '(none)',
    '',
    '## Goal',
    '',
    `Title:\n${input.goal.title}`,
    '',
  ];
  if (input.goal.focusType) lines.push(`Classification:\n${input.goal.focusType}`, '');
  if (input.goal.outcome) lines.push(`Outcome:\n${input.goal.outcome}`, '');
  if (input.goal.targetDate) lines.push(`Target date:\n${input.goal.targetDate}`, '');
  if (input.goal.why) lines.push(`Why:\n${input.goal.why}`, '');
  if (input.goal.metric) {
    lines.push('## Outcome Metric', '', input.goal.metric, '');
  }

  const current = input.milestones.find((m) => m.status === 'current');
  if (current) {
    lines.push('## Current Stage', '', current.title, '');
  }

  lines.push('## Milestones', '');
  for (const m of input.milestones) {
    const mark = m.status === 'done' ? 'x' : m.status === 'current' ? '>' : ' ';
    lines.push(`- [${mark}] ${m.title}`);
  }
  lines.push('');

  lines.push('## Systems / Processes', '');
  for (const p of input.processes) {
    lines.push(`### ${p.name}`);
    lines.push(`Completed: ${p.completed ?? '—'}`);
    lines.push(`Planned: ${p.planned ?? '—'}`);
    lines.push(`Target: ${p.target}${p.unit ? ` ${p.unit}` : ''} / week`);
    lines.push('');
  }

  lines.push('## Linked Projects', '');
  for (const p of input.projects) {
    lines.push(`### ${p.title}`);
    if (p.purpose) lines.push(`Purpose:\n${p.purpose}`);
    if (p.nextAction) lines.push(`Next action:\n${p.nextAction}`);
    lines.push('');
  }

  lines.push('## Current Tasks / Remaining Work', '');
  for (const t of input.tasks.filter((task) => !task.done)) {
    const horizon = t.dueHorizon ?? 'unspecified';
    const sched = t.scheduled ? 'scheduled' : 'unscheduled';
    lines.push(`- ${t.title} — ${horizon} — ${sched}`);
  }
  if (!input.tasks.some((t) => !t.done)) lines.push('(none)');
  lines.push('');

  if (input.timeProtectedMinutes != null) {
    lines.push('## Time Protected', '', `${input.timeProtectedMinutes} minutes this week`, '');
  }

  if (input.progress) {
    lines.push('## Progress', '');
    if (
      input.progress.consistencyMetWeeks != null
      && input.progress.consistencyTotalWeeks != null
    ) {
      lines.push(
        `Consistency:\n${input.progress.consistencyMetWeeks} / ${input.progress.consistencyTotalWeeks} weeks`,
        '',
      );
    }
    if (input.progress.insight) lines.push(`Relevant observations:\n${input.progress.insight}`, '');
  }

  if (input.reflection?.trim()) {
    lines.push('## Reflection', '', input.reflection.trim(), '');
  }

  lines.push(
    '## Context for an external AI',
    '',
    'Please use the information above as the source of truth.',
    'Help me evaluate or improve this Goal without assuming I want to replace the existing structure.',
    'When recommending changes, distinguish: Goal outcome, Metric, Milestone, System / Process, Project, Task.',
    'Do not invent personal facts not contained in this context.',
  );

  return lines.join('\n');
}
