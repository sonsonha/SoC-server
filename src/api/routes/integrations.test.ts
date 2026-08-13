import { describe, expect, it } from 'vitest';
import { createWebOAuthState, verifyWebOAuthState } from './integrations.js';

describe('web Google OAuth state', () => {
  const secret = 'test-device-pepper-long-enough';

  it('accepts a fresh signed state', () => {
    const state = createWebOAuthState(secret, 1_000_000);
    expect(verifyWebOAuthState(state, secret, 1_005_000)).toBe(true);
  });

  it('rejects tampering and stale state', () => {
    const state = createWebOAuthState(secret, 1_000_000);
    expect(verifyWebOAuthState(`${state}x`, secret, 1_005_000)).toBe(false);
    expect(verifyWebOAuthState(state, secret, 1_700_001)).toBe(false);
  });
});
