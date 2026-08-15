import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import { flaggedQueueSummary } from './flagged-summary';

/**
 * The line above the queue is the only thing on the page that makes a claim about
 * tickets it cannot see, so the cases that matter are the ones where the page and
 * the queue disagree.
 */
describe('flaggedQueueSummary', () => {
  it('counts a complete queue', () => {
    expect(flaggedQueueSummary(3, false, content)).toBe(content.assignment.flaggedCount(3));
  });

  it('says nothing at all when the queue is empty and complete', () => {
    // The table's empty state already explains it; a "0 tickets flagged" line
    // above "Nothing is stuck" is two sentences for one fact.
    expect(flaggedQueueSummary(0, false, content)).toBeNull();
  });

  it('admits truncation instead of reporting the page as a total', () => {
    const line = flaggedQueueSummary(25, true, content);

    expect(line).toBe(content.assignment.flaggedShowingOldest(25));
    expect(line).not.toBe(content.assignment.flaggedCount(25));
  });

  it('still admits truncation when every row on the page was dropped', () => {
    // `toFlaggedTicketRows` discards a ticket whose routing columns disagree, so
    // zero rows and a further page is reachable — and silence there would read as
    // "nothing is stuck" while the queue is full.
    expect(flaggedQueueSummary(0, true, content)).toBe(content.assignment.flaggedShowingOldest(0));
  });

  it('never claims a total the request did not ask for', () => {
    // Whatever the rendering, a truncated page must not produce the bare count
    // sentence — that is the shape that read "25 tickets flagged" for a queue of 32.
    for (const rowCount of [0, 1, 25]) {
      expect(flaggedQueueSummary(rowCount, true, content)).not.toBe(
        content.assignment.flaggedCount(rowCount),
      );
    }
  });
});
