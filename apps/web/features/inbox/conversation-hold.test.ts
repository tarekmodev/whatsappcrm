import { describe, expect, it } from 'vitest';
import { conversationHold } from './conversation-hold';

const ME = '0192f001-0000-7000-8000-000000000102';
const SOMEBODY_ELSE = '0192f001-0000-7000-8000-000000000104';

describe('conversationHold', () => {
  it('reads an unassigned conversation as the shared pool', () => {
    expect(conversationHold(null, ME, null)).toEqual({ state: 'unclaimed' });
  });

  it('reads my own conversation as mine', () => {
    expect(conversationHold(ME, ME, 'Priya Raman')).toEqual({ state: 'mine' });
  });

  it('keeps "held by a colleague" distinct from "nobody has it"', () => {
    // The distinction the `isMine` boolean could not make, and the reason this
    // exists: collapsing these two showed "Claim" over somebody else's work.
    expect(conversationHold(SOMEBODY_ELSE, ME, 'Liang Wei')).toEqual({
      state: 'theirs',
      holderName: 'Liang Wei',
    });
  });

  it('still reports a hold when the holder’s name does not resolve', () => {
    // The directory read is one page. An unresolved name must not downgrade a
    // held thread to an unclaimed one.
    expect(conversationHold(SOMEBODY_ELSE, ME, null)).toEqual({
      state: 'theirs',
      holderName: null,
    });
  });
});
