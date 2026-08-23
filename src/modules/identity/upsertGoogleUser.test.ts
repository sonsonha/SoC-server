import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from './identityService.js';

describe('IdentityService.upsertGoogleUser', () => {
  it('upgrades stale google_sub for the same email instead of inserting a duplicate', async () => {
    const rows: Array<Record<string, unknown>> = [{
      id: 'user-terry',
      googleSub: 'STALE_SUB',
      email: 'terryson821@gmail.com',
      name: 'Terry',
      avatarUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
      onboardingCompletedAt: null,
    }];

    let selectPass = 0;
    const db = {
      select: () => ({
        from: () => {
          selectPass += 1;
          if (selectPass === 1) {
            // lookup by google_sub — miss
            return { where: () => ({ limit: async () => [] }) };
          }
          if (selectPass === 2) {
            // email scan: await db.select().from(users)
            return Promise.resolve(rows);
          }
          // refresh after update
          return { where: () => ({ limit: async () => rows }) };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            Object.assign(rows[0]!, values);
          },
        }),
      }),
      insert: () => ({
        values: async () => {
          throw new Error('must not insert duplicate Terry');
        },
      }),
    };

    const identity = new IdentityService(
      db as never,
      new Set(['terryson821@gmail.com']),
      'owner@example.com',
    );
    const user = await identity.upsertGoogleUser({
      sub: 'SUB_B',
      email: 'terryson821@gmail.com',
      emailVerified: true,
      name: 'Terry',
      picture: null,
    });
    expect(user.id).toBe('user-terry');
    expect(user.googleSub).toBe('SUB_B');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.googleSub).toBe('SUB_B');
  });

  it('inserts a brand-new user when email and sub are unknown', async () => {
    const rows: Array<Record<string, unknown>> = [];
    let selectPass = 0;
    const db = {
      select: () => ({
        from: () => {
          selectPass += 1;
          if (selectPass === 1) {
            return { where: () => ({ limit: async () => [] }) };
          }
          return Promise.resolve(rows);
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            throw new Error('no update');
          },
        }),
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          rows.push({ ...values });
        },
      }),
    };
    const identity = new IdentityService(
      db as never,
      new Set(['terryson821@gmail.com']),
    );
    const user = await identity.upsertGoogleUser({
      sub: 'SUB_B',
      email: 'terryson821@gmail.com',
      emailVerified: true,
      name: 'Terry',
      picture: null,
    });
    expect(user.googleSub).toBe('SUB_B');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('terryson821@gmail.com');
  });
});

void vi;
