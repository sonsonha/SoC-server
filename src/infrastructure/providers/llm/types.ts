export type PreparationStructure = {
  goal: string;
  practicePrompt: string;
  doneCriteria: string[];
};

export type IntakeInterpretation = {
  kind:
    | 'LEARNING'
    | 'TASK'
    | 'WAITING'
    | 'DECISION'
    | 'OPPORTUNITY_RESEARCH'
    | 'EXPLORATION'
    | 'SOCIAL'
    | 'UNKNOWN';
  title: string;
  lifeArea: string;
  estimatedMinutes?: number;
  learningTitle?: string;
  needsConfirm: boolean;
  person?: { name: string; relationship?: string };
  waitingItem?: { title: string; waitingOn?: string; followUpDays?: number };
  task?: { title: string; status?: 'TODO' | 'WAITING' };
  decisionContext?: string;
  decisionOptions?: Array<{ label: string; pros?: string; cons?: string }>;
  deadlineHint?: string;
  opportunityTitle?: string;
  explorationQuestion?: string;
  socialOccasion?: string;
  socialArea?: string;
  socialCuisine?: string[];
  socialVibe?: string[];
  socialDatetimeHint?: string;
};

export interface LlmProvider {
  interpretIntake(text: string, context: string): Promise<IntakeInterpretation>;
  structurePreparation(input: {
    topic: string;
    timeBudgetMinutes: number;
    candidate: { title: string; url: string; snippet: string };
  }): Promise<PreparationStructure>;
}
