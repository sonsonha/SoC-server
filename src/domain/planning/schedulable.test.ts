import { describe, expect, it } from 'vitest';
import { isSchedulableTaskStatus } from './schedulable.js';

describe('isSchedulableTaskStatus', () => {
  it('excludes WAITING tasks', () => {
    expect(isSchedulableTaskStatus('WAITING')).toBe(false);
  });

  it('excludes DONE and CANCELLED', () => {
    expect(isSchedulableTaskStatus('DONE')).toBe(false);
    expect(isSchedulableTaskStatus('CANCELLED')).toBe(false);
  });

  it('includes active statuses', () => {
    expect(isSchedulableTaskStatus('TODO')).toBe(true);
    expect(isSchedulableTaskStatus('IN_PROGRESS')).toBe(true);
    expect(isSchedulableTaskStatus('SCHEDULED')).toBe(true);
  });
});
