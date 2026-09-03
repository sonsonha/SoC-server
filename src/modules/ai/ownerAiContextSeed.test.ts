import { describe, expect, it, vi } from 'vitest';
import { seedOwnerAiContext, type OwnerAiContextSeedUser } from './ownerAiContextSeed.js';
import { INITIAL_OWNER_AI_CONTEXT_DEFAULT } from './ownerAiContextDefault.js';
import { normalizeAiContextEmail } from './userAiContext.js';

function repository(users: OwnerAiContextSeedUser[]) {
  const setContextIfBlank = vi.fn(async (userId: string, aiContext: string) => {
    const user = users.find((candidate) => candidate.id === userId);
    if (!user || user.aiContext?.trim()) return false;
    user.aiContext = aiContext;
    return true;
  });
  return {
    findByNormalizedEmail: async (email: string) =>
      users.filter((user) => normalizeAiContextEmail(user.email) === email),
    setContextIfBlank,
  };
}

describe('seedOwnerAiContext', () => {
  it('seeds an empty explicit owner without touching User B', async () => {
    const rows: OwnerAiContextSeedUser[] = [
      { id: 'owner-id', email: 'Owner@Example.com', aiContext: null },
      { id: 'user-b-id', email: 'b@example.com', aiContext: null },
    ];
    const repo = repository(rows);
    const result = await seedOwnerAiContext(repo, ' owner@example.com ');

    expect(result).toEqual({
      ownerEmail: 'Owner@Example.com',
      contextBefore: 'empty',
      action: 'seeded',
    });
    expect(rows[0]?.aiContext).toBe(INITIAL_OWNER_AI_CONTEXT_DEFAULT);
    expect(rows[1]?.aiContext).toBeNull();
  });

  it('skips an owner with saved context and never overwrites edits', async () => {
    const rows: OwnerAiContextSeedUser[] = [
      { id: 'owner-id', email: 'owner@example.com', aiContext: 'MY EDITED CONTEXT' },
    ];
    const repo = repository(rows);
    const result = await seedOwnerAiContext(repo, 'owner@example.com');

    expect(result.action).toBe('skipped');
    expect(result.contextBefore).toBe('non-empty');
    expect(rows[0]?.aiContext).toBe('MY EDITED CONTEXT');
    expect(repo.setContextIfBlank).not.toHaveBeenCalled();
  });
});
