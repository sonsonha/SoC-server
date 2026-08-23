import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import {
  isAllowedPlannerWebReturnUrl,
  oauthErrorRedirectUrl,
  oauthSuccessRedirectUrl,
  resolvePlannerWebReturnUrl,
} from './oauthReturnUrl.js';

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    DATABASE_URL: 'postgres://localhost/personal_os',
    PORT: 3000,
    HOST: '0.0.0.0',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DEVICE_AUTH_PEPPER: 'test-device-auth-pepper',
    WORKER_ENABLED: false,
    DEEPSEEK_MODEL: 'deepseek-chat',
    LLM_PROVIDER: 'fake',
    CALENDAR_PULL_INTERVAL_MS: 900_000,
    NOTIFY_MAX_PER_DAY: 8,
    PROACTIVE_SCAN_INTERVAL_MS: 2_700_000,
    USE_FAKE_PROVIDERS: false,
    ...overrides,
  };
}

describe('oauth return URL', () => {
  it('redirects success/failure to configured Vercel /calendar', () => {
    const config = baseConfig({
      PLANNER_WEB_RETURN_URL: 'https://personal-planner-web-ivory.vercel.app',
    });
    expect(oauthSuccessRedirectUrl(config)).toBe(
      'https://personal-planner-web-ivory.vercel.app/calendar?google=connected',
    );
    expect(oauthErrorRedirectUrl(config, 'access_denied')).toBe(
      'https://personal-planner-web-ivory.vercel.app/calendar?google=error&reason=access_denied',
    );
  });

  it('rejects legacy chatgpt.site return URLs', () => {
    const config = baseConfig({
      PLANNER_WEB_RETURN_URL:
        'https://personal-os-calendar-planner.terryson821.chatgpt.site',
    });
    expect(() => resolvePlannerWebReturnUrl(config)).toThrow(/chatgpt\.site/);
  });

  it('requires PLANNER_WEB_RETURN_URL in production', () => {
    expect(() => resolvePlannerWebReturnUrl(baseConfig({ NODE_ENV: 'production' }))).toThrow(
      /required in production/,
    );
  });

  it('defaults to localhost only outside production', () => {
    expect(resolvePlannerWebReturnUrl(baseConfig({ NODE_ENV: 'development' }))).toBe(
      'http://localhost:3000',
    );
  });

  it('does not allow arbitrary origins to override the configured return URL', () => {
    const config = baseConfig({
      PLANNER_WEB_RETURN_URL: 'https://personal-planner-web-ivory.vercel.app',
    });
    expect(
      isAllowedPlannerWebReturnUrl('https://evil.example/?google=connected', config),
    ).toBe(false);
    expect(
      isAllowedPlannerWebReturnUrl(
        'https://personal-planner-web-ivory.vercel.app/calendar?google=connected',
        config,
      ),
    ).toBe(true);
  });
});
