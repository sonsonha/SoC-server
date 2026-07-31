import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('API integration', () => {
  let app: FastifyInstance;
  let deviceId = '';
  let deviceSecret = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEVICE_AUTH_PEPPER ??= 'test-pepper-abcdefgh';
    process.env.LOG_LEVEL ??= 'error';
    const config = loadConfig();
    await runMigrations(config.DATABASE_URL);
    const db = createDb(config.DATABASE_URL);
    const { app: builtApp } = await buildApp({ config, db });
    app = builtApp;
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeDb();
  });

  it('GET /health returns 200 when DB is up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
  });

  it('POST /v1/device/register returns id + secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      payload: { label: 'vitest', force: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.deviceId).toBeTruthy();
    expect(body.deviceSecret).toBeTruthy();
    deviceId = body.deviceId;
    deviceSecret = body.deviceSecret;
  });

  it('rejects duplicate register without force', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      payload: { label: 'second' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('GET /v1/ping without auth → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ping' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/ping with valid auth → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { authorization: `Device ${deviceId}:${deviceSecret}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(deviceId);
  });

  it('sync/push same mutationId twice is idempotent', async () => {
    const mutationId = randomUUID();
    const payload = {
      mutations: [
        {
          mutationId,
          entityType: 'ping',
          entityId: 'test',
          operation: 'upsert',
          payload: {},
          clientTimestamp: new Date().toISOString(),
        },
      ],
    };
    const headers = { authorization: `Device ${deviceId}:${deviceSecret}` };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().applied).toContain(mutationId);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().applied).toContain(mutationId);
    expect(second.json().conflicts).toEqual([]);
  });

  it('sync/pull returns entities and a cursor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sync/pull',
      headers: { authorization: `Device ${deviceId}:${deviceSecret}` },
      payload: { since: '0' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.entities)).toBe(true);
    expect(body.cursor).toBeTruthy();
    expect(body.serverTime).toBeTruthy();
  });
});
