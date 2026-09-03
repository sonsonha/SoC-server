import { INITIAL_OWNER_AI_CONTEXT_DEFAULT } from './ownerAiContextDefault.js';

export const MAX_AI_CONTEXT_CHARS = 12_000;

export type ResolvedUserAiContext = {
  aiContext: string;
  isDefaultSeed: boolean;
};

export function normalizeAiContextEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? '';
}

/** Owner status is explicit. A missing owner configuration never means owner. */
export function isInitialOwnerAiContextUser(
  userEmail: string,
  initialOwnerEmail?: string | null,
): boolean {
  const owner = normalizeAiContextEmail(initialOwnerEmail);
  return Boolean(owner && normalizeAiContextEmail(userEmail) === owner);
}

/**
 * Single source of truth for saved-vs-owner-default AI Context precedence.
 * Saved non-blank context always wins; only the configured owner gets fallback.
 */
export function resolveUserAiContext(input: {
  userEmail: string;
  savedContext?: string | null;
  initialOwnerEmail?: string | null;
}): ResolvedUserAiContext {
  if (input.savedContext != null && input.savedContext.trim()) {
    return {
      aiContext: input.savedContext.slice(0, MAX_AI_CONTEXT_CHARS),
      isDefaultSeed: false,
    };
  }
  if (isInitialOwnerAiContextUser(input.userEmail, input.initialOwnerEmail)) {
    return {
      aiContext: INITIAL_OWNER_AI_CONTEXT_DEFAULT.slice(0, MAX_AI_CONTEXT_CHARS),
      isDefaultSeed: true,
    };
  }
  return { aiContext: '', isDefaultSeed: false };
}
