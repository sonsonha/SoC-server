import type { ZodError } from 'zod';

/** Safe Zod issue summary for logs — no prompts, keys, or full payloads. */
export function formatZodIssuesSafe(error: ZodError): Array<{
  path: string;
  code: string;
  message: string;
  expected?: unknown;
  received?: unknown;
}> {
  return error.issues.map((issue) => {
    const row: {
      path: string;
      code: string;
      message: string;
      expected?: unknown;
      received?: unknown;
    } = {
      path: issue.path.join('.') || '(root)',
      code: issue.code,
      message: issue.message,
    };
    if ('expected' in issue) row.expected = (issue as { expected?: unknown }).expected;
    if ('received' in issue) {
      const received = (issue as { received?: unknown }).received;
      row.received = typeof received === 'string' && received.length > 120
        ? `${received.slice(0, 120)}…`
        : received;
    }
    return row;
  });
}

export function safeTopLevelKeys(raw: unknown): string[] | string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.keys(raw as Record<string, unknown>).slice(0, 40);
  }
  return typeof raw;
}
