import { describe, expect, it } from 'vitest';
import {
  DEV_DATA_RESET_OVERRIDE,
  assertSafeDevelopmentDatabase,
  describeDatabaseTarget,
} from './devDataSafety.js';

const local = 'postgres://sonha@localhost:5432/secretary';

describe('assertSafeDevelopmentDatabase', () => {
  it('allows local development Postgres', () => {
    const target = assertSafeDevelopmentDatabase({
      databaseUrl: local,
      nodeEnv: 'development',
    });
    expect(target).toEqual({ host: 'localhost', port: '5432', database: 'secretary', user: 'sonha' });
  });

  it('refuses production NODE_ENV even on localhost', () => {
    expect(() => assertSafeDevelopmentDatabase({
      databaseUrl: local,
      nodeEnv: 'production',
    })).toThrow(/NODE_ENV=production/);
  });

  it('refuses Railway hosts without an explicit override', () => {
    expect(() => assertSafeDevelopmentDatabase({
      databaseUrl: 'postgresql://postgres:x@hopper.proxy.rlwy.net:1234/railway',
      nodeEnv: 'development',
    })).toThrow(/remote database host/);
  });

  it('refuses when RAILWAY_ENVIRONMENT is set', () => {
    expect(() => assertSafeDevelopmentDatabase({
      databaseUrl: local,
      nodeEnv: 'development',
      railwayEnvironment: 'production',
    })).toThrow(/RAILWAY_ENVIRONMENT/);
  });

  it('allows a remote host only with the destructive override', () => {
    const target = assertSafeDevelopmentDatabase({
      databaseUrl: 'postgresql://postgres:x@hopper.proxy.rlwy.net:1234/railway',
      nodeEnv: 'development',
      allowOverride: DEV_DATA_RESET_OVERRIDE,
    });
    expect(target.host).toBe('hopper.proxy.rlwy.net');
  });
});

describe('describeDatabaseTarget', () => {
  it('does not include the password', () => {
    const target = describeDatabaseTarget('postgres://sonha:hunter2@127.0.0.1:5432/secretary');
    expect(JSON.stringify(target)).not.toContain('hunter2');
    expect(target.host).toBe('127.0.0.1');
    expect('password' in target).toBe(false);
  });
});
