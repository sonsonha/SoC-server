import { describe, expect, it } from 'vitest';
import { generateDeviceSecret, hashSecret, verifySecret } from '../src/application/deviceService.js';

describe('device crypto', () => {
  it('hashes and verifies secrets', () => {
    const pepper = 'test-pepper-abcdefgh';
    const secret = generateDeviceSecret();
    const hash = hashSecret(secret, pepper);
    expect(verifySecret(secret, pepper, hash)).toBe(true);
    expect(verifySecret('wrong', pepper, hash)).toBe(false);
  });

  it('generates url-safe secrets', () => {
    const secret = generateDeviceSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(40);
  });
});
