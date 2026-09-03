/**
 * Harmless representation normalization before Zod.
 * Does not invent business meaning for unknown values.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function emptyToUndefined(value: unknown): unknown {
  if (value === '') return undefined;
  return value;
}

function coerceNumber(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return value;
}

function normalizeConfidence(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const key = value.trim().toUpperCase();
  if (key === 'HIGH' || key === 'MEDIUM' || key === 'LOW') return key;
  return value;
}

function normalizeMetricType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const map: Record<string, string> = {
    COUNT: 'COUNT',
    DURATION: 'DURATION',
    HOURS: 'DURATION',
    HOUR: 'DURATION',
    MINUTES: 'DURATION',
    MINUTE: 'DURATION',
    MINS: 'DURATION',
    MIN: 'DURATION',
    TIME: 'DURATION',
    NUMBER: 'NUMBER',
    BOOLEAN: 'BOOLEAN',
    BOOL: 'BOOLEAN',
    PERCENTAGE: 'PERCENTAGE',
    PERCENT: 'PERCENTAGE',
    PCT: 'PERCENTAGE',
    CUSTOM: 'CUSTOM',
  };
  return map[key] ?? value;
}

function normalizeProcessMetricType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const map: Record<string, string> = {
    COUNT: 'COUNT',
    DURATION: 'DURATION',
    HOURS: 'DURATION',
    HOUR: 'DURATION',
    MINUTES: 'DURATION',
    MINUTE: 'DURATION',
    MINS: 'DURATION',
    MIN: 'DURATION',
    TIME: 'DURATION',
  };
  return map[key] ?? value;
}

function normalizePeriod(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const key = value.trim().toUpperCase();
  if (key === 'WEEK' || key === 'WEEKLY' || key === 'PER_WEEK' || key === 'PERWEEK') {
    return 'WEEK';
  }
  return value;
}

function normalizeReviewCadence(value: unknown): unknown {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  const key = value.trim().toUpperCase();
  const map: Record<string, string> = {
    WEEKLY: 'WEEKLY',
    WEEK: 'WEEKLY',
    MONTHLY: 'MONTHLY',
    MONTH: 'MONTHLY',
    MILESTONE: 'MILESTONE',
    MILESTONES: 'MILESTONE',
  };
  return map[key] ?? value;
}

function normalizeOutcome(value: unknown): unknown {
  const obj = asRecord(value);
  if (!obj) return value;
  return {
    ...obj,
    statement: emptyToUndefined(obj.statement),
    confidence: normalizeConfidence(obj.confidence),
  };
}

function normalizeMetric(value: unknown): unknown {
  const obj = asRecord(value);
  if (!obj) return value;
  return {
    ...obj,
    name: emptyToUndefined(obj.name),
    metricType: normalizeMetricType(obj.metricType),
    currentValue: coerceNumber(emptyToUndefined(obj.currentValue) ?? null),
    targetValue: coerceNumber(emptyToUndefined(obj.targetValue) ?? null),
    unit: emptyToUndefined(obj.unit) ?? null,
    rationale: emptyToUndefined(obj.rationale) ?? null,
    confidence: normalizeConfidence(obj.confidence),
  };
}

function normalizeMilestone(value: unknown): unknown {
  const obj = asRecord(value);
  if (!obj) return value;
  return {
    ...obj,
    title: emptyToUndefined(obj.title),
    description: emptyToUndefined(obj.description) ?? null,
    rationale: emptyToUndefined(obj.rationale) ?? null,
  };
}

function normalizeProcess(value: unknown): unknown {
  const obj = asRecord(value);
  if (!obj) return value;
  return {
    ...obj,
    name: emptyToUndefined(obj.name),
    metricType: normalizeProcessMetricType(obj.metricType),
    targetValue: coerceNumber(obj.targetValue),
    period: normalizePeriod(obj.period ?? 'WEEK'),
    unit: emptyToUndefined(obj.unit) ?? null,
    rationale: emptyToUndefined(obj.rationale) ?? null,
    confidence: normalizeConfidence(obj.confidence),
  };
}

function normalizeProjectType(value: unknown): unknown {
  if (value == null || value === '') return 'STANDARD';
  if (typeof value !== 'string') return value;
  const key = value.trim().toUpperCase();
  if (key === 'HABIT' || key === 'HABITS' || key === 'RECURRING') return 'HABIT';
  if (key === 'STANDARD' || key === 'PROJECT' || key === 'FINITE') return 'STANDARD';
  return value;
}

function normalizeProject(value: unknown): unknown {
  const obj = asRecord(value);
  if (!obj) return value;
  return {
    ...obj,
    title: emptyToUndefined(obj.title),
    purpose: emptyToUndefined(obj.purpose) ?? null,
    projectType: normalizeProjectType(obj.projectType),
    suggestedDefaultProcessName: emptyToUndefined(obj.suggestedDefaultProcessName) ?? null,
    rationale: emptyToUndefined(obj.rationale) ?? null,
  };
}

/** Legacy Systems key — tolerate if present; not required for new suggestions. */
function normalizeSystem(value: unknown): unknown {
  const obj = asRecord(value);
  if (!obj) return value;
  return {
    ...obj,
    title: emptyToUndefined(obj.title),
    targetValue: coerceNumber(obj.targetValue),
    targetType: typeof obj.targetType === 'string' ? obj.targetType.trim().toUpperCase() : obj.targetType,
    period: normalizePeriod(obj.period ?? 'WEEK'),
    durationWeeks: coerceNumber(obj.durationWeeks),
    unit: emptyToUndefined(obj.unit) ?? null,
    startDate: emptyToUndefined(obj.startDate) ?? null,
    preferredDays: Array.isArray(obj.preferredDays) ? obj.preferredDays.map(coerceNumber) : null,
    preferredTime: emptyToUndefined(obj.preferredTime) ?? null,
    rationale: emptyToUndefined(obj.rationale) ?? null,
  };
}

function normalizeNextAction(value: unknown): unknown {
  const obj = asRecord(value);
  if (!obj) return value;
  return {
    ...obj,
    title: emptyToUndefined(obj.title),
    estimatedMinutes: coerceNumber(emptyToUndefined(obj.estimatedMinutes) ?? null),
    projectTitle: emptyToUndefined(obj.projectTitle) ?? null,
  };
}

function ensureArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [];
}

/** Normalize DeepSeek (or other) JSON before Zod validation. */
export function normalizeGoalStructureSuggestion(raw: unknown): unknown {
  const obj = asRecord(raw);
  if (!obj) return raw;

  return {
    ...obj,
    outcome: obj.outcome != null ? normalizeOutcome(obj.outcome) : undefined,
    metrics: ensureArray(obj.metrics).map(normalizeMetric),
    milestones: ensureArray(obj.milestones).map(normalizeMilestone),
    processes: ensureArray(obj.processes).map(normalizeProcess),
    // Legacy only — omit when absent so systems is not required.
    ...(obj.systems != null
      ? { systems: ensureArray(obj.systems).map(normalizeSystem) }
      : {}),
    projects: Array.isArray(obj.projects) ? obj.projects.map(normalizeProject) : obj.projects,
    timeProtectedMinutesPerWeek: coerceNumber(
      emptyToUndefined(obj.timeProtectedMinutesPerWeek) ?? null,
    ),
    nextActions: ensureArray(obj.nextActions).map(normalizeNextAction),
    reviewCadence: normalizeReviewCadence(obj.reviewCadence),
    assumptions: ensureArray(obj.assumptions).map((a) =>
      typeof a === 'string' ? a : a == null ? '' : String(a),
    ).filter((a) => a.trim() !== ''),
    questionsForUser: obj.questionsForUser == null
      ? undefined
      : ensureArray(obj.questionsForUser).map((q) =>
          typeof q === 'string' ? q : q == null ? '' : String(q),
        ).filter((q) => q.trim() !== ''),
  };
}
