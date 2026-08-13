import { slaTimerTargetFor } from './sla-timer-target';

/**
 * 0006's lifecycle diagram, one row per edge.
 *
 * This is the function that makes the evaluate handler a reconciler: it answers
 * from the ticket alone, never from the trigger that woke it, so a job that is
 * lost, duplicated or delivered out of order converges on the same state.
 */

const RESPONDED = new Date('2026-08-13T09:30:00.000Z');
const RESOLVED = new Date('2026-08-13T10:00:00.000Z');

describe('slaTimerTargetFor', () => {
  describe('the first-response timer', () => {
    it('runs while the ticket is open and unanswered', () => {
      expect(
        slaTimerTargetFor({
          kind: 'first_response',
          status: 'open',
          firstRespondedAt: null,
          resolvedAt: null,
        }),
      ).toBe('running');
    });

    /**
     * Waiting on the customer is time the agent cannot act on, and billing them
     * for it would make the deadline meaningless.
     */
    it('pauses while the ticket is pending on the customer', () => {
      expect(
        slaTimerTargetFor({
          kind: 'first_response',
          status: 'pending',
          firstRespondedAt: null,
          resolvedAt: null,
        }),
      ).toBe('paused');
    });

    it('is met once a person has replied', () => {
      expect(
        slaTimerTargetFor({
          kind: 'first_response',
          status: 'open',
          firstRespondedAt: RESPONDED,
          resolvedAt: null,
        }),
      ).toBe('met');
    });

    /**
     * The answer stays `met` even from a paused ticket: a reply that landed is a
     * fact about the past, and the ticket's current status cannot unmake it.
     */
    it('is met from a pending ticket too', () => {
      expect(
        slaTimerTargetFor({
          kind: 'first_response',
          status: 'pending',
          firstRespondedAt: RESPONDED,
          resolvedAt: null,
        }),
      ).toBe('met');
    });

    it.each(['resolved', 'closed'] as const)(
      'is cancelled on a %s ticket nobody ever answered',
      (status) => {
        expect(
          slaTimerTargetFor({
            kind: 'first_response',
            status,
            firstRespondedAt: null,
            resolvedAt: null,
          }),
        ).toBe('cancelled');
      },
    );
  });

  describe('the resolution timer', () => {
    it('runs while the ticket is open, even once it has been answered', () => {
      expect(
        slaTimerTargetFor({
          kind: 'resolution',
          status: 'open',
          firstRespondedAt: RESPONDED,
          resolvedAt: null,
        }),
      ).toBe('running');
    });

    it('is met when the ticket is resolved', () => {
      expect(
        slaTimerTargetFor({
          kind: 'resolution',
          status: 'resolved',
          firstRespondedAt: RESPONDED,
          resolvedAt: RESOLVED,
        }),
      ).toBe('met');
    });

    it('is cancelled when the ticket is closed without being resolved', () => {
      expect(
        slaTimerTargetFor({
          kind: 'resolution',
          status: 'closed',
          firstRespondedAt: RESPONDED,
          resolvedAt: null,
        }),
      ).toBe('cancelled');
    });
  });
});
