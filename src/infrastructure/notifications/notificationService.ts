import { randomUUID } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { deviceFcmTokens, notificationLog } from '../db/schema/index.js';
import type { PushProvider } from './types.js';
import {
  TYPE_DAILY_CAPS,
  allowedTypesForAutonomy,
  type AutonomyLevel,
  type NotificationType,
  type PushPayload,
} from './types.js';

export type NotifyRequest = {
  deviceId?: string;
  /** If omitted, broadcast to all registered devices (respecting each autonomy/budget). */
  type: NotificationType;
  title: string;
  body: string;
  deepLink: string;
  entityType: string;
  entityId: string;
};

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly push: PushProvider,
    private readonly maxPerDay: number,
  ) {}

  async registerToken(
    deviceId: string,
    token: string,
    opts: { platform?: string; autonomy?: AutonomyLevel } = {},
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(deviceFcmTokens)
      .values({
        deviceId,
        token,
        platform: opts.platform ?? 'android',
        autonomy: opts.autonomy ?? 'SUGGEST',
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: deviceFcmTokens.deviceId,
        set: {
          token,
          platform: opts.platform ?? 'android',
          ...(opts.autonomy ? { autonomy: opts.autonomy } : {}),
          updatedAt: now,
        },
      });
  }

  async clearToken(deviceId: string): Promise<void> {
    await this.db.delete(deviceFcmTokens).where(eq(deviceFcmTokens.deviceId, deviceId));
  }

  async setAutonomy(deviceId: string, autonomy: AutonomyLevel): Promise<void> {
    const rows = await this.db
      .select()
      .from(deviceFcmTokens)
      .where(eq(deviceFcmTokens.deviceId, deviceId))
      .limit(1);
    if (rows[0]) {
      await this.db
        .update(deviceFcmTokens)
        .set({ autonomy, updatedAt: new Date() })
        .where(eq(deviceFcmTokens.deviceId, deviceId));
    } else {
      await this.db.insert(deviceFcmTokens).values({
        deviceId,
        token: '',
        platform: 'android',
        autonomy,
        updatedAt: new Date(),
      });
    }
  }

  async notify(req: NotifyRequest): Promise<{ sent: number; skipped: number }> {
    const devices = req.deviceId
      ? await this.db
          .select()
          .from(deviceFcmTokens)
          .where(eq(deviceFcmTokens.deviceId, req.deviceId))
      : await this.db.select().from(deviceFcmTokens);

    let sent = 0;
    let skipped = 0;
    const payload: PushPayload = {
      type: req.type,
      title: req.title,
      body: req.body,
      deepLink: req.deepLink,
      entityType: req.entityType,
      entityId: req.entityId,
    };

    for (const device of devices) {
      if (!device.token) {
        skipped += 1;
        continue;
      }
      const autonomy = (device.autonomy as AutonomyLevel) || 'SUGGEST';
      const allowed = allowedTypesForAutonomy(autonomy);
      if (!allowed.has(req.type)) {
        skipped += 1;
        continue;
      }
      const underBudget = await this.checkBudget(device.deviceId, req.type);
      if (!underBudget) {
        skipped += 1;
        continue;
      }

      const result = await this.push.send(device.token, payload);
      if (result.ok) {
        await this.db.insert(notificationLog).values({
          id: randomUUID(),
          deviceId: device.deviceId,
          type: req.type,
          title: req.title,
          body: req.body,
          deepLink: req.deepLink,
          entityType: req.entityType,
          entityId: req.entityId,
          sentAt: new Date(),
        });
        sent += 1;
      } else {
        skipped += 1;
      }
    }

    return { sent, skipped };
  }

  async countToday(deviceId: string): Promise<number> {
    const start = startOfUtcDay(new Date());
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationLog)
      .where(and(eq(notificationLog.deviceId, deviceId), gte(notificationLog.sentAt, start)));
    return Number(rows[0]?.count ?? 0);
  }

  private async checkBudget(deviceId: string, type: NotificationType): Promise<boolean> {
    const start = startOfUtcDay(new Date());
    const totalRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationLog)
      .where(and(eq(notificationLog.deviceId, deviceId), gte(notificationLog.sentAt, start)));
    const total = Number(totalRows[0]?.count ?? 0);
    if (total >= this.maxPerDay) return false;

    const typeCap = TYPE_DAILY_CAPS[type] ?? 2;
    const typeRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.deviceId, deviceId),
          eq(notificationLog.type, type),
          gte(notificationLog.sentAt, start),
        ),
      );
    const typeCount = Number(typeRows[0]?.count ?? 0);
    return typeCount < typeCap;
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}
