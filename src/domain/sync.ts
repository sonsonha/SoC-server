export type SyncEntity = {
  entityType: string;
  entityId: string;
  revision: number;
  updatedAt: string;
  deletedAt?: string;
  payload: Record<string, unknown>;
};

export type ClientMutation = {
  mutationId: string;
  entityType: string;
  entityId: string;
  operation: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  clientTimestamp: string;
};

export type SyncPullRequest = {
  since: string;
};

export type SyncPullResponse = {
  entities: SyncEntity[];
  cursor: string;
  serverTime: string;
};

export type SyncPushRequest = {
  mutations: ClientMutation[];
};

export type SyncPushResponse = {
  applied: string[];
  conflicts: Array<{ mutationId: string; reason: string }>;
  cursor: string;
};
