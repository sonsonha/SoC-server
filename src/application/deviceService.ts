import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import { deviceCredentials } from '../infrastructure/db/schema/index.js';

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function generateDeviceSecret(): string {
  return base64Url(randomBytes(32));
}

export function hashSecret(secret: string, pepper: string): string {
  const salt = createHash('sha256').update(pepper).digest();
  const derived = scryptSync(secret + pepper, salt, 64);
  return base64Url(derived);
}

export function verifySecret(secret: string, pepper: string, storedHash: string): boolean {
  const computed = hashSecret(secret, pepper);
  const a = Buffer.from(computed);
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type RegisterResult = {
  deviceId: string;
  deviceSecret: string;
  registeredAt: string;
};

export class DeviceService {
  constructor(
    private readonly db: Db,
    private readonly pepper: string,
  ) {}

  async register(opts: { label?: string; force?: boolean }): Promise<RegisterResult> {
    const existing = await this.db.select({ id: deviceCredentials.id }).from(deviceCredentials).limit(1);
    if (existing.length > 0 && !opts.force) {
      const err = new Error('A device is already registered. Pass force=true to replace (dev only).');
      (err as Error & { statusCode?: number; code?: string }).statusCode = 409;
      (err as Error & { code?: string }).code = 'DEVICE_EXISTS';
      throw err;
    }

    if (opts.force && existing.length > 0) {
      await this.db.delete(deviceCredentials);
    }

    const deviceId = randomUUID();
    const deviceSecret = generateDeviceSecret();
    const secretHash = hashSecret(deviceSecret, this.pepper);
    const now = new Date();

    await this.db.insert(deviceCredentials).values({
      id: deviceId,
      secretHash,
      label: opts.label ?? null,
      createdAt: now,
      lastSeenAt: now,
    });

    return {
      deviceId,
      deviceSecret,
      registeredAt: now.toISOString(),
    };
  }

  async authenticate(deviceId: string, secret: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(deviceCredentials)
      .where(eq(deviceCredentials.id, deviceId))
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    const ok = verifySecret(secret, this.pepper, row.secretHash);
    if (ok) {
      await this.db
        .update(deviceCredentials)
        .set({ lastSeenAt: new Date() })
        .where(eq(deviceCredentials.id, deviceId));
    }
    return ok;
  }

  async countDevices(): Promise<number> {
    const rows = await this.db.execute(sql`select count(*)::int as count from device_credentials`);
    const first = rows[0] as { count?: number } | undefined;
    return first?.count ?? 0;
  }
}
