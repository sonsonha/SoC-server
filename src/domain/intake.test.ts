import { describe, expect, it } from 'vitest';
import { intakeInterpretationSchema } from './intake.js';

describe('intakeInterpretationSchema', () => {
  it('accepts valid learning interpretation', () => {
    const parsed = intakeInterpretationSchema.parse({
      kind: 'LEARNING',
      title: 'TCP reliability deep dive',
      lifeArea: 'LEARNING',
      estimatedMinutes: 45,
      learningTitle: 'TCP reliability',
      needsConfirm: false,
    });
    expect(parsed.kind).toBe('LEARNING');
  });

  it('rejects malformed LLM output', () => {
    expect(() =>
      intakeInterpretationSchema.parse({
        kind: 'LEARNING',
        title: '',
        lifeArea: 'LEARNING',
        estimatedMinutes: -5,
        needsConfirm: false,
      }),
    ).toThrow();
  });

  it('accepts WAITING interpretation', () => {
    const parsed = intakeInterpretationSchema.parse({
      kind: 'WAITING',
      title: 'API spec for billing',
      lifeArea: 'CORE_WORK',
      needsConfirm: false,
      person: { name: 'Alex' },
      waitingItem: { title: 'API spec', waitingOn: 'Alex' },
      task: { title: 'Integrate billing', status: 'WAITING' },
    });
    expect(parsed.kind).toBe('WAITING');
  });

  it('rejects unknown kind', () => {
    expect(() =>
      intakeInterpretationSchema.parse({
        kind: 'INVALID',
        title: 'Test',
        lifeArea: 'LEARNING',
        estimatedMinutes: 30,
        needsConfirm: false,
      }),
    ).toThrow();
  });
});
