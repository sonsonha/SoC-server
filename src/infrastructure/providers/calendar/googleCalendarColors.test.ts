import { describe, expect, it } from 'vitest';
import {
  googleEventColorIdFromHex,
  googleEventColorIdFromPriority,
  resolveGoogleEventColorId,
} from './googleCalendarColors.js';

describe('googleCalendarColors', () => {
  it('maps planner priorities to Google event colorIds', () => {
    expect(googleEventColorIdFromPriority('P1')).toBe('11');
    expect(googleEventColorIdFromPriority('HIGH')).toBe('11');
    expect(googleEventColorIdFromPriority(1)).toBe('11');
    expect(googleEventColorIdFromPriority('P2')).toBe('9');
    expect(googleEventColorIdFromPriority('NORMAL')).toBe('9');
    expect(googleEventColorIdFromPriority('P3')).toBe('10');
    expect(googleEventColorIdFromPriority('LOW')).toBe('10');
    expect(googleEventColorIdFromPriority('P4')).toBe('5');
    expect(googleEventColorIdFromPriority('DROP')).toBe('5');
  });

  it('maps known Personal OS hex colors', () => {
    expect(googleEventColorIdFromHex('#dc2626')).toBe('11');
    expect(googleEventColorIdFromHex('#2563eb')).toBe('9');
    expect(googleEventColorIdFromHex('#16a34a')).toBe('10');
    expect(googleEventColorIdFromHex('#ca8a04')).toBe('5');
    expect(googleEventColorIdFromHex('#705CF6')).toBe('3');
  });

  it('prefers priority over hex when resolving', () => {
    expect(resolveGoogleEventColorId({ priority: 'P1', color: '#2563eb' })).toBe('11');
    expect(resolveGoogleEventColorId({ color: '#16a34a' })).toBe('10');
    expect(resolveGoogleEventColorId({})).toBe('9');
  });
});
