export type GoalProcessMeasurementType = 'COUNT' | 'DURATION' | 'BINARY' | 'CUSTOM_METRIC';
export type GoalProcessPeriod = 'DAY' | 'WEEK' | 'MONTH';
export type GoalOutcomeStatus =
  | 'ACTIVE'
  | 'ACHIEVED_ON_TIME'
  | 'ACHIEVED_LATE'
  | 'PARTIALLY_ACHIEVED'
  | 'NOT_ACHIEVED'
  | 'STOPPED_INTENTIONALLY'
  | 'NO_LONGER_RELEVANT';

export type GoalProcess = {
  id: string;
  name: string;
  measurementType: GoalProcessMeasurementType;
  targetValue: number;
  unit?: string;
  period: GoalProcessPeriod;
  active: boolean;
};

export type GoalMetricObservation = {
  id: string;
  observedAt: string;
  value: number;
  note?: string;
  label?: string;
};

export type GoalReflection = {
  seriousAttempt?: 'NOT_REALLY' | 'PARTLY' | 'YES' | null;
  worked?: string;
  didntWork?: string;
  outsideControl?: string;
  learned?: string;
  differently?: string;
  nextAction?: 'ARCHIVE' | 'EXTEND' | 'REVISE' | 'FOLLOW_UP' | 'MAINTAIN' | 'STOP' | null;
  reviewedAt?: string | null;
};

export type GoalReviewSnapshot = {
  generatedAt: string;
  outcomeStatus: GoalOutcomeStatus;
  targetDate: string | null;
  achievedAt: string | null;
  processSummary: Array<{
    processId: string;
    name: string;
    completed: number;
    planned: number;
    target: number;
    unit?: string;
  }>;
  consistency: { metWeeks: number; totalWeeks: number; threshold: number };
  milestones: Array<{ id: string; title: string; status: string }>;
  latestObservation?: GoalMetricObservation | null;
};

export type GoalTaskEvidence = {
  id: string;
  title: string;
  goalId: string | null;
  goalProcessId: string | null;
  projectId: string | null;
  status: 'INBOX' | 'SCHEDULED' | 'DONE';
  dueAt: string | null;
  completedAt: string | null;
};

export type GoalBlockEvidence = {
  id: string;
  taskId: string | null;
  startAt: string;
  endAt: string;
  durationMinutes: number;
};

export type GoalProgressBucket = {
  target: number;
  planned: number;
  completed: number;
  unit?: string;
};

export type GoalProgressProcessSummary = {
  id: string;
  name: string;
  measurementType: GoalProcessMeasurementType;
  period: GoalProcessPeriod;
  unit?: string;
  thisWeek: GoalProgressBucket;
  thisMonth: GoalProgressBucket;
  allTime: GoalProgressBucket;
};

export type GoalProgressResult = {
  processes: GoalProgressProcessSummary[];
  consistency: {
    threshold: number;
    weeks: Array<{ startAt: string; ratio: number; met: boolean }>;
    metWeeks: number;
    totalWeeks: number;
  };
  latestObservation: GoalMetricObservation | null;
  observationTrend: 'improving' | 'stable' | 'declining' | 'insufficient_data';
  activity: Array<{
    taskId: string;
    title: string;
    processId: string | null;
    completedAt: string | null;
    plannedMinutes: number;
  }>;
  insight: {
    processState: 'none' | 'low' | 'mixed' | 'strong';
    outcomeState: 'none' | 'insufficient_data' | 'improving' | 'stable' | 'declining';
    message: string;
  };
};

function startOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfWeek(value: Date) {
  const date = startOfDay(value);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function startOfMonth(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function addDays(value: Date, amount: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

function addMonths(value: Date, amount: number) {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1);
}

function within(dateIso: string | null, start: Date, end: Date) {
  if (!dateIso) return false;
  const time = new Date(dateIso).getTime();
  return time >= start.getTime() && time < end.getTime();
}

function ratio(bucket: GoalProgressBucket) {
  if (bucket.target <= 0) return 0;
  return Math.min(bucket.completed / bucket.target, 1.25);
}

function bucketsForProcess(process: GoalProcess, now: Date) {
  const weekStart = startOfWeek(now);
  const weekEnd = addDays(weekStart, 7);
  const monthStart = startOfMonth(now);
  const monthEnd = addMonths(monthStart, 1);
  return {
    thisWeek: { start: weekStart, end: weekEnd },
    thisMonth: { start: monthStart, end: monthEnd },
  };
}

function targetForWindow(process: GoalProcess, start: Date, end: Date) {
  if (!process.active) return 0;
  if (process.period === 'DAY') {
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000)) * process.targetValue;
  }
  if (process.period === 'MONTH') {
    const monthCount = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    return Math.max(1, monthCount) * process.targetValue;
  }
  let count = 0;
  let cursor = startOfWeek(start);
  while (cursor.getTime() < end.getTime()) {
    count += 1;
    cursor = addDays(cursor, 7);
  }
  return count * process.targetValue;
}

function taskPlannedMinutes(task: GoalTaskEvidence, blocks: GoalBlockEvidence[], start: Date, end: Date) {
  return blocks
    .filter((block) => block.taskId === task.id && within(block.startAt, start, end))
    .reduce((sum, block) => sum + block.durationMinutes, 0);
}

function taskCompletedMinutes(task: GoalTaskEvidence, blocks: GoalBlockEvidence[], start: Date, end: Date) {
  if (task.status !== 'DONE' || !within(task.completedAt, start, end)) return 0;
  return taskPlannedMinutes(task, blocks, start, end);
}

function computeBucket(
  process: GoalProcess,
  tasks: GoalTaskEvidence[],
  blocks: GoalBlockEvidence[],
  start: Date,
  end: Date,
): GoalProgressBucket {
  const linkedTasks = tasks.filter((task) => task.goalProcessId === process.id);
  const target = targetForWindow(process, start, end);
  if (process.measurementType === 'DURATION') {
    const plannedMinutes = linkedTasks.reduce((sum, task) => sum + taskPlannedMinutes(task, blocks, start, end), 0);
    const completedMinutes = linkedTasks.reduce((sum, task) => sum + taskCompletedMinutes(task, blocks, start, end), 0);
    return {
      target,
      planned: Math.round((plannedMinutes / 60) * 10) / 10,
      completed: Math.round((completedMinutes / 60) * 10) / 10,
      unit: process.unit || 'h',
    };
  }

  const plannedTaskIds = new Set(
    linkedTasks
      .filter((task) => taskPlannedMinutes(task, blocks, start, end) > 0)
      .map((task) => task.id),
  );
  const completedTaskIds = linkedTasks
    .filter((task) => task.status === 'DONE' && within(task.completedAt, start, end))
    .map((task) => task.id);

  if (process.measurementType === 'BINARY') {
    return {
      target,
      planned: plannedTaskIds.size > 0 ? 1 : 0,
      completed: completedTaskIds.length > 0 ? 1 : 0,
      unit: process.unit,
    };
  }

  return {
    target,
    planned: plannedTaskIds.size,
    completed: completedTaskIds.length,
    unit: process.unit,
  };
}

export function buildGoalProgress(
  processes: GoalProcess[],
  observations: GoalMetricObservation[],
  tasks: GoalTaskEvidence[],
  blocks: GoalBlockEvidence[],
  now: Date,
): GoalProgressResult {
  const scoped = processes.filter((process) => process.active);
  const processSummaries = scoped.map((process) => {
    const ranges = bucketsForProcess(process, now);
    return {
      id: process.id,
      name: process.name,
      measurementType: process.measurementType,
      period: process.period,
      unit: process.unit,
      thisWeek: computeBucket(process, tasks, blocks, ranges.thisWeek.start, ranges.thisWeek.end),
      thisMonth: computeBucket(process, tasks, blocks, ranges.thisMonth.start, ranges.thisMonth.end),
      allTime: computeBucket(process, tasks, blocks, new Date(0), addDays(startOfDay(now), 1)),
    };
  });

  const threshold = 0.8;
  const weeks = Array.from({ length: 8 }, (_, index) => {
    const start = addDays(startOfWeek(now), (index - 7) * 7);
    const end = addDays(start, 7);
    const ratios = scoped.map((process) => ratio(computeBucket(process, tasks, blocks, start, end)));
    const weekRatio = ratios.length ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : 0;
    return {
      startAt: start.toISOString(),
      ratio: Math.round(weekRatio * 100) / 100,
      met: ratios.length > 0 && weekRatio >= threshold,
    };
  });

  const sortedObservations = [...observations].sort((a, b) =>
    new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime(),
  );
  const latestObservation = sortedObservations.at(-1) ?? null;
  const recentTwo = sortedObservations.slice(-2);
  const observationTrend = recentTwo.length < 2
    ? 'insufficient_data'
    : recentTwo[1]!.value > recentTwo[0]!.value
      ? 'improving'
      : recentTwo[1]!.value < recentTwo[0]!.value
        ? 'declining'
        : 'stable';

  const avgRatio = processSummaries.length
    ? processSummaries.reduce((sum, item) => sum + ratio(item.thisWeek), 0) / processSummaries.length
    : 0;
  const processState = processSummaries.length === 0
    ? 'none'
    : avgRatio >= 0.8
      ? 'strong'
      : avgRatio >= 0.45
        ? 'mixed'
        : 'low';
  const outcomeState = sortedObservations.length === 0 ? 'none' : observationTrend;
  const message = processState === 'strong' && outcomeState === 'improving'
    ? 'Current system appears to be producing progress.'
    : processState === 'strong' && (outcomeState === 'stable' || outcomeState === 'declining')
      ? 'Execution has been consistent, but the outcome metric has changed little.'
      : processState === 'low' && (outcomeState === 'stable' || outcomeState === 'declining' || outcomeState === 'none')
        ? 'The current system has not been executed consistently enough to evaluate it confidently.'
        : processState === 'none'
          ? 'No recurring process is defined for this goal yet.'
          : 'Evidence is still accumulating.';

  const activity = tasks
    .filter((task) => task.status === 'DONE' || blocks.some((block) => block.taskId === task.id))
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      processId: task.goalProcessId,
      completedAt: task.completedAt,
      plannedMinutes: taskPlannedMinutes(task, blocks, addDays(startOfWeek(now), -21), addDays(startOfDay(now), 1)),
    }))
    .sort((a, b) => new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime());

  return {
    processes: processSummaries,
    consistency: {
      threshold,
      weeks,
      metWeeks: weeks.filter((week) => week.met).length,
      totalWeeks: weeks.length,
    },
    latestObservation,
    observationTrend,
    activity,
    insight: {
      processState,
      outcomeState,
      message,
    },
  };
}
