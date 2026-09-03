import {
  normalizeAiContextEmail,
  resolveUserAiContext,
} from './userAiContext.js';

export type OwnerAiContextSeedUser = {
  id: string;
  email: string;
  aiContext: string | null;
};

export type OwnerAiContextSeedRepository = {
  findByNormalizedEmail(email: string): Promise<OwnerAiContextSeedUser[]>;
  setContextIfBlank(userId: string, aiContext: string): Promise<boolean>;
};

export type OwnerAiContextSeedResult = {
  ownerEmail: string;
  contextBefore: 'empty' | 'non-empty';
  action: 'seeded' | 'skipped';
};

/** Production-safe, idempotent owner seed. It never overwrites saved context. */
export async function seedOwnerAiContext(
  repository: OwnerAiContextSeedRepository,
  configuredOwnerEmail: string,
): Promise<OwnerAiContextSeedResult> {
  const ownerEmail = normalizeAiContextEmail(configuredOwnerEmail);
  if (!ownerEmail) {
    throw new Error('PERSONAL_OS_INITIAL_OWNER_EMAIL is required');
  }

  const matches = await repository.findByNormalizedEmail(ownerEmail);
  if (matches.length === 0) {
    throw new Error(`No user matches PERSONAL_OS_INITIAL_OWNER_EMAIL=${ownerEmail}`);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one user for PERSONAL_OS_INITIAL_OWNER_EMAIL=${ownerEmail}`);
  }

  const owner = matches[0]!;
  if (owner.aiContext?.trim()) {
    return { ownerEmail: owner.email, contextBefore: 'non-empty', action: 'skipped' };
  }

  const resolved = resolveUserAiContext({
    userEmail: owner.email,
    savedContext: owner.aiContext,
    initialOwnerEmail: ownerEmail,
  });
  if (!resolved.isDefaultSeed || !resolved.aiContext) {
    throw new Error('Initial owner AI Context fallback could not be resolved');
  }

  const seeded = await repository.setContextIfBlank(owner.id, resolved.aiContext);
  return {
    ownerEmail: owner.email,
    contextBefore: 'empty',
    action: seeded ? 'seeded' : 'skipped',
  };
}
