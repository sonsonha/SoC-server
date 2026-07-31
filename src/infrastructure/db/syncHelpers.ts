import type { SyncEntity } from '../../domain/sync.js';

type SyncRow = {
  id: string;
  revision: number;
  updatedAt: Date;
  deletedAt: Date | null;
  [key: string]: unknown;
};

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[camelToSnake(k)] = serializeValue(v);
    }
    return out;
  }
  return value;
}

export function rowToSyncEntity(entityType: string, row: SyncRow): SyncEntity {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'revision' || key === 'updatedAt' || key === 'deletedAt') continue;
    payload[camelToSnake(key)] = serializeValue(value);
  }
  return {
    entityType,
    entityId: row.id,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString(),
    payload,
  };
}

export function parseSinceCursor(since: string): Date {
  if (!since || since === '0') return new Date(0);
  const asNum = Number(since);
  if (!Number.isNaN(asNum) && asNum > 0) return new Date(asNum);
  const parsed = Date.parse(since);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  return new Date(0);
}

export function nextCursor(dates: Date[], fallback: string): string {
  if (dates.length === 0) return fallback;
  const max = Math.max(...dates.map((d) => d.getTime()));
  return String(max);
}
