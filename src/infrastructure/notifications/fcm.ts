import type { PushPayload, PushProvider } from './types.js';

export class FakePushProvider implements PushProvider {
  readonly sent: Array<{ token: string; payload: PushPayload }> = [];

  async send(token: string, payload: PushPayload) {
    this.sent.push({ token, payload });
    return { ok: true, messageId: `fake-${this.sent.length}` };
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** No-op provider used when FCM credentials are absent. */
export class NoopPushProvider implements PushProvider {
  async send(_token: string, payload: PushPayload) {
    console.info(`[fcm:noop] ${payload.type} — ${payload.title}`);
    return { ok: true, messageId: 'noop' };
  }
}

/**
 * Legacy FCM HTTP API (server key). Prefer Firebase Admin on Railway when available.
 * Env: FCM_SERVER_KEY
 */
export class LegacyFcmPushProvider implements PushProvider {
  constructor(private readonly serverKey: string) {}

  async send(token: string, payload: PushPayload) {
    try {
      const res = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          Authorization: `key=${this.serverKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: token,
          priority: 'high',
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data: {
            type: payload.type,
            deepLink: payload.deepLink,
            entityType: payload.entityType,
            entityId: payload.entityId,
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: text.slice(0, 200) };
      }
      const json = (await res.json()) as { message_id?: number };
      return { ok: true, messageId: String(json.message_id ?? 'fcm') };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
