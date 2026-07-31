import type { AppConfig } from '../../config.js';
import { FakePushProvider, LegacyFcmPushProvider, NoopPushProvider } from './fcm.js';
import type { PushProvider } from './types.js';

export function createPushProvider(config: AppConfig): PushProvider {
  if (config.USE_FAKE_PROVIDERS) {
    return new FakePushProvider();
  }
  if (config.FCM_SERVER_KEY) {
    return new LegacyFcmPushProvider(config.FCM_SERVER_KEY);
  }
  return new NoopPushProvider();
}

export { FakePushProvider, LegacyFcmPushProvider, NoopPushProvider } from './fcm.js';
export { NotificationService } from './notificationService.js';
export type { PushPayload, PushProvider, NotificationType, AutonomyLevel } from './types.js';
export { allowedTypesForAutonomy } from './types.js';
