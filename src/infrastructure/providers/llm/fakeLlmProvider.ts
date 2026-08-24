import type {
  IntakeInterpretation,
  LlmProvider,
  PreparationStructure,
} from './types.js';

function extractMinutes(text: string): number {
  const m = text.match(/(\d+)\s*(?:min(?:ute)?s?|m\b)/i);
  if (m) return Math.min(180, Math.max(5, Number(m[1])));
  return 45;
}

function extractTitle(text: string): string {
  const cleaned = text
    .replace(/^(schedule|i want to|please)\s+/i, '')
    .replace(/\s+for\s+\d+\s+minutes?.*$/i, '')
    .trim();
  if (cleaned.length > 80) return `${cleaned.slice(0, 77)}...`;
  return cleaned || 'Learning session';
}

function extractPersonName(text: string): string | null {
  const m = text.match(/waiting on ([A-Z][a-z]+)/i);
  return m?.[1] ?? null;
}

function extractWaitingTitle(text: string): string {
  const cleaned = text
    .replace(/^waiting on [A-Z][a-z]+\s+(to\s+)?/i, '')
    .replace(/^waiting for [A-Z][a-z]+\s+(to\s+)?/i, '')
    .trim();
  if (cleaned.length > 100) return `${cleaned.slice(0, 97)}...`;
  return cleaned || 'Pending item';
}

function parseDecisionOptions(text: string): Array<{ label: string; pros?: string; cons?: string }> {
  const vsMatch = text.match(/(.+?)\s+vs\.?\s+(.+?)(?:\s+by|\s+before|$)/i);
  if (vsMatch) {
    return [
      { label: vsMatch[1].trim().replace(/^decide:?\s*/i, '') },
      { label: vsMatch[2].trim() },
    ];
  }
  const orMatch = text.match(/(.+?)\s+or\s+(.+?)(?:\s+by|\s+before|$)/i);
  if (orMatch) {
    return [
      { label: orMatch[1].trim().replace(/^need to decide:?\s*/i, '') },
      { label: orMatch[2].trim() },
    ];
  }
  return [
    { label: 'Option A' },
    { label: 'Option B' },
  ];
}

export class FakeLlmProvider implements LlmProvider {
  async interpretIntake(text: string, _context: string): Promise<IntakeInterpretation> {
    const lower = text.toLowerCase();
    const minutes = extractMinutes(text);
    const title = extractTitle(text);

    if (/\bwaiting on\b|\bwaiting for\b/i.test(text)) {
      const personName = extractPersonName(text) ?? 'Someone';
      const waitingTitle = extractWaitingTitle(text);
      return {
        kind: 'WAITING',
        title: waitingTitle,
        lifeArea: 'CORE_WORK',
        needsConfirm: false,
        person: { name: personName, relationship: 'colleague' },
        waitingItem: { title: waitingTitle, waitingOn: personName, followUpDays: 3 },
        task: { title: waitingTitle, status: 'WAITING' },
      };
    }

    if (/\bdecide\b|\bdecision\b|\bvs\.?\b|\bor apply\b/i.test(lower)) {
      const options = parseDecisionOptions(text);
      const decisionTitle = text.replace(/^need to decide:?\s*/i, '').slice(0, 120);
      return {
        kind: 'DECISION',
        title: decisionTitle || 'Open decision',
        lifeArea: 'CAREER',
        needsConfirm: false,
        decisionContext: text,
        decisionOptions: options,
        deadlineHint: /\bseptember\b/i.test(text) ? 'September' : undefined,
      };
    }

    if (
      /\bwhat should i know\b|\bexplore\b|\bbefore (my )?(trip|visit)\b|\btech scene\b|\bsingapore\b/i.test(
        lower,
      )
    ) {
      return {
        kind: 'EXPLORATION',
        title: text.slice(0, 120),
        lifeArea: 'OPPORTUNITY',
        estimatedMinutes: minutes,
        explorationQuestion: text,
        needsConfirm: false,
      };
    }

    if (/\bprepare for\b|\bfellowship\b|\bscholarship\b|\bapplying to\b/i.test(lower)) {
      const oppTitle =
        text.match(/(?:prepare for|applying to)\s+(.+?)(?:\s+this|\s+by|$)/i)?.[1]?.trim() ??
        text.slice(0, 80);
      return {
        kind: 'OPPORTUNITY_RESEARCH',
        title: oppTitle,
        lifeArea: 'OPPORTUNITY',
        estimatedMinutes: minutes,
        opportunityTitle: oppTitle,
        needsConfirm: false,
      };
    }

    if (
      /\bdate night\b|\bdinner\b|\bcoffee with\b|\bmeetup\b|\bnear (marina|jurong)\b|\bquiet cafe\b/i.test(
        lower,
      )
    ) {
      const cuisine: string[] = [];
      if (/\bjapanese\b/i.test(lower)) cuisine.push('japanese');
      if (/\bcoffee\b|\bcafe\b/i.test(lower)) cuisine.push('cafe');
      const vibe: string[] = [];
      if (/\bquiet\b/i.test(lower)) vibe.push('quiet');
      return {
        kind: 'SOCIAL',
        title: text.slice(0, 120),
        lifeArea: 'HUMAN',
        estimatedMinutes: minutes || 90,
        socialOccasion: text.slice(0, 120),
        socialArea: /\bmarina bay\b/i.test(lower)
          ? 'Marina Bay'
          : /\bjurong\b/i.test(lower)
            ? 'Jurong'
            : 'Singapore',
        socialCuisine: cuisine.length ? cuisine : undefined,
        socialVibe: vibe.length ? vibe : undefined,
        socialDatetimeHint: /\bfriday\b/i.test(lower) ? 'Friday 19:00' : undefined,
        needsConfirm: false,
      };
    }

    const isLearning =
      /\b(learn|learning|study|read|deep dive|interview prep)\b/i.test(text) ||
      /\b(tcp|network|os|distributed)\b/i.test(lower);

    if (isLearning) {
      return {
        kind: 'LEARNING',
        title,
        lifeArea: 'LEARNING',
        estimatedMinutes: minutes,
        learningTitle: title,
        needsConfirm: false,
      };
    }

    return {
      kind: 'TASK',
      title,
      lifeArea: 'CORE_WORK',
      estimatedMinutes: minutes,
      needsConfirm: false,
    };
  }

  async structurePreparation(input: {
    topic: string;
    timeBudgetMinutes: number;
    candidate: { title: string; url: string; snippet: string };
  }): Promise<PreparationStructure> {
    const topic = input.topic;
    return {
      goal: `Understand ${topic} well enough to explain key concepts clearly in ${input.timeBudgetMinutes} minutes.`,
      practicePrompt: `After reading "${input.candidate.title}", write a short summary of the main ideas and one open question.`,
      doneCriteria: [
        `Can explain ${topic} in your own words`,
        'Completed the practice summary',
        `Spent at least ${Math.max(15, input.timeBudgetMinutes - 10)} focused minutes`,
      ],
    };
  }

  async structureGoal(prompt: string): Promise<unknown> {
    const lower = prompt.toLowerCase();
    const isJob = /\b(job|backend|offer|interview|career)\b/.test(lower);
    if (isJob) {
      return {
        outcome: {
          statement: 'Receive at least one suitable Backend Developer offer.',
          confidence: 'HIGH',
        },
        metrics: [
          {
            name: 'Suitable offers',
            metricType: 'COUNT',
            currentValue: 0,
            targetValue: 1,
            unit: 'offers',
            rationale: 'Directly maps to the job outcome.',
            confidence: 'HIGH',
            needsUserDecision: false,
          },
        ],
        milestones: [
          { title: 'CV / profile ready' },
          { title: 'Application pipeline established' },
          { title: 'Interview pipeline established' },
          { title: 'Technical interview readiness demonstrated' },
          { title: 'Suitable offer received' },
        ],
        processes: [
          {
            name: 'Quality Applications',
            metricType: 'COUNT',
            targetValue: 5,
            period: 'WEEK',
            unit: 'apps',
            rationale: 'Steady pipeline without spam volume.',
            confidence: 'HIGH',
          },
          {
            name: 'Technical Preparation',
            metricType: 'DURATION',
            targetValue: 180,
            period: 'WEEK',
            unit: 'min',
            rationale: 'Repeatable depth beats one-off cramming.',
            confidence: 'HIGH',
          },
          {
            name: 'Mock Interview',
            metricType: 'COUNT',
            targetValue: 1,
            period: 'WEEK',
            unit: 'sessions',
            confidence: 'MEDIUM',
          },
        ],
        projects: [
          {
            title: 'Job Applications',
            purpose: 'Maintain the active application pipeline.',
            suggestedDefaultProcessName: 'Quality Applications',
          },
          {
            title: 'Backend Interview Preparation',
            purpose: 'Prepare technical fundamentals and interview skills.',
            suggestedDefaultProcessName: 'Technical Preparation',
          },
          {
            title: 'Portfolio / CV Polish',
            purpose: 'Improve application material and technical presentation.',
            suggestedDefaultProcessName: null,
          },
        ],
        timeProtectedMinutesPerWeek: 180,
        nextActions: [
          { title: 'Research 3 target companies', estimatedMinutes: 45, projectTitle: 'Job Applications' },
          { title: 'Review transactions and isolation', estimatedMinutes: 60, projectTitle: 'Backend Interview Preparation' },
          { title: 'Schedule one mock interview', estimatedMinutes: 20, projectTitle: 'Backend Interview Preparation' },
        ],
        reviewCadence: 'WEEKLY',
        assumptions: [
          'Backend roles are currently a primary career target.',
          'The user already has baseline software engineering experience.',
        ],
        questionsForUser: [],
      };
    }
    return {
      outcome: {
        statement: 'Make meaningful progress on the stated Goal with a clear success check.',
        confidence: 'MEDIUM',
      },
      metrics: [
        {
          name: 'Primary outcome check',
          metricType: 'CUSTOM',
          currentValue: null,
          targetValue: null,
          unit: null,
          rationale: 'Metric needs clarification for this Goal.',
          confidence: 'LOW',
          needsUserDecision: true,
          possibleAlternatives: [
            'Binary completion of a concrete deliverable',
            'A countable weekly process metric',
            'A measurable outcome number',
          ],
        },
      ],
      milestones: [
        { title: 'Clarify success criteria' },
        { title: 'Establish weekly system' },
        { title: 'Ship first meaningful checkpoint' },
        { title: 'Goal outcome achieved' },
      ],
      processes: [
        {
          name: 'Focused work',
          metricType: 'DURATION',
          targetValue: 180,
          period: 'WEEK',
          unit: 'min',
          confidence: 'MEDIUM',
          rationale: 'Protect a small repeatable block of time.',
        },
      ],
      projects: [
        {
          title: 'Foundation project',
          purpose: 'Finite body of work that advances the Goal.',
          suggestedDefaultProcessName: 'Focused work',
        },
      ],
      timeProtectedMinutesPerWeek: 180,
      nextActions: [{ title: 'Write a one-sentence outcome definition', estimatedMinutes: 15 }],
      reviewCadence: 'WEEKLY',
      assumptions: ['The Goal needs a clearer metric before strong tracking.'],
      questionsForUser: ['What evidence would convince you this Goal is done?'],
    };
  }
}
