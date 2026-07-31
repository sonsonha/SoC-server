export type NotificationType =
  | 'PREP_READY'
  | 'PLAN_UPDATED'
  | 'WAITING_FOLLOW_UP'
  | 'DEADLINE'
  | 'PREP_NEEDS_INPUT';

export type AutonomyLevel = 'SUGGEST' | 'INTERNAL_PLAN' | 'COS_CALENDAR_WRITE' | 'PROACTIVE_REPLAN';

export type PushPayload = {
  type: NotificationType;
  title: string;
  body: string;
  deepLink: string;
  entityType: string;
  entityId: string;
};

export interface PushProvider {
  send(token: string, payload: PushPayload): Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

/** Types allowed per autonomy level (inclusive of lower levels). */
export function allowedTypesForAutonomy(autonomy: AutonomyLevel): Set<NotificationType> {
  switch (autonomy) {
    case 'SUGGEST':
      return new Set(['PREP_READY', 'PREP_NEEDS_INPUT']);
    case 'INTERNAL_PLAN':
    case 'COS_CALENDAR_WRITE':
      return new Set(['PREP_READY', 'PREP_NEEDS_INPUT', 'PLAN_UPDATED', 'DEADLINE']);
    case 'PROACTIVE_REPLAN':
      return new Set([
        'PREP_READY',
        'PREP_NEEDS_INPUT',
        'PLAN_UPDATED',
        'DEADLINE',
        'WAITING_FOLLOW_UP',
      ]);
    default:
      return new Set(['PREP_READY']);
  }
}

export const TYPE_DAILY_CAPS: Partial<Record<NotificationType, number>> = {
  PREP_READY: 4,
  PLAN_UPDATED: 3,
  WAITING_FOLLOW_UP: 2,
  DEADLINE: 2,
  PREP_NEEDS_INPUT: 2,
};
