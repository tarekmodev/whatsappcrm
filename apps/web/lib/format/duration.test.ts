import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import { formatMinutes } from './duration';

/**
 * The case both callers are most likely to hit and least likely to expect: a
 * duration entered in minutes and read back in hours. A workflow's
 * "unresolved for 240 minutes" and an SLA window of 240 minutes must phrase
 * that number identically.
 */
describe('formatMinutes', () => {
  it.each([
    [30, '30 minutes'],
    [90, '90 minutes'],
    [60, '1 hour'],
    [240, '4 hours'],
    [2880, '2 days'],
  ])('reads %i minutes as %s', (minutes, expected) => {
    expect(formatMinutes(minutes, content)).toBe(expected);
  });
});
