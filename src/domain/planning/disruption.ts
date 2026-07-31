import { z } from 'zod';

export const disruptionTypeSchema = z.enum([
  'NEW_MEETING',
  'NEW_URGENT_TASK',
  'URGENT_WORK',
  'OVERRUN',
  'ENERGY_CRASH',
  'LOCATION_CHANGE',
  'SOCIAL_INVITE',
  'OTHER',
]);

export type DisruptionType = z.infer<typeof disruptionTypeSchema>;

export const disruptionPayloadSchema = z.object({
  type: disruptionTypeSchema,
  // Android kotlinx may send explicit JSON null for unset optionals.
  title: z.string().nullish(),
  startAt: z.string().nullish(),
  endAt: z.string().nullish(),
  ownership: z.enum(['EXTERNAL', 'COS', 'MANUAL']).nullish(),
  locationId: z.string().nullish(),
  taskId: z.string().nullish(),
  nextAction: z.string().nullish(),
  mode: z.enum(['HIGH', 'NORMAL', 'LOW', 'CRISIS']).nullish(),
  note: z.string().nullish(),
});

export type DisruptionPayload = z.infer<typeof disruptionPayloadSchema>;

export const replanRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  from: z.string().datetime().nullish(),
  disruption: disruptionPayloadSchema,
});

export type ReplanAdjustmentKind = 'MOVED' | 'INSERTED' | 'DROPPED' | 'SHRUNK' | 'UNCHANGED';

export type ReplanAdjustment = {
  kind: ReplanAdjustmentKind;
  blockId: string;
  title: string;
  from?: string;
  to?: string;
  detail?: string;
};

export type PlanBlockRecord = {
  id: string;
  dailyPlanId: string;
  date: string;
  startEpochMs: number;
  endEpochMs: number;
  type: string;
  ownership: string;
  title: string;
  taskId: string | null;
  habitId: string | null;
  commitmentId: string | null;
  locationId: string | null;
  locked: boolean;
  preparationId: string | null;
  revision: number;
};

export type ReplanImpact = {
  blocksMoved: number;
  blocksDropped: number;
  blocksInserted: number;
  anchorsPreserved: number;
};

export type ReplanResult = {
  summary: string;
  impact: ReplanImpact;
  adjustments: ReplanAdjustment[];
  blocks: PlanBlockRecord[];
};
