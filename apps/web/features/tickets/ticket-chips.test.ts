import { describe, expect, it } from 'vitest';
import type { TicketPriority, TicketStatus } from '@whatsappcrm/contracts';
import type { ObservableSlaState } from '@/features/sla/presentation';
import {
  TICKET_MARK_BUDGET,
  ticketMarkEmphasis,
  type TicketMarkEmphasis,
  type TicketMarkFilter,
} from './ticket-chips';

const NO_FILTER: TicketMarkFilter = { status: undefined, priority: undefined };

function marks(
  priority: TicketPriority,
  status: TicketStatus,
  sla: ObservableSlaState | null,
  filter: TicketMarkFilter = NO_FILTER,
): TicketMarkEmphasis {
  return ticketMarkEmphasis({ priority, status }, sla, filter);
}

function loudCount(emphasis: TicketMarkEmphasis): number {
  return Object.values(emphasis).filter(Boolean).length;
}

describe('ticketMarkEmphasis', () => {
  /**
   * The row the review counted three pills on: `Urgent` + `Open` + `Overdue`.
   * `open` is the ordinary state and loses; the two that decide what an agent
   * does next keep their badges.
   */
  it('drops the open status rather than the urgency or the breach', () => {
    expect(marks('urgent', 'open', 'breached')).toEqual({
      priority: true,
      status: false,
      sla: true,
    });
  });

  it('never lets a row carry more than the budget', () => {
    const priorities: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
    const statuses: TicketStatus[] = ['open', 'pending', 'resolved', 'closed'];
    const states: (ObservableSlaState | null)[] = ['breached', 'running', 'paused', 'met', null];

    for (const priority of priorities) {
      for (const status of statuses) {
        for (const state of states) {
          expect(loudCount(marks(priority, status, state))).toBeLessThanOrEqual(TICKET_MARK_BUDGET);
        }
      }
    }
  });

  it('gives a breach the loudest slot even against an urgent ticket', () => {
    expect(marks('urgent', 'pending', 'breached')).toEqual({
      priority: true,
      status: false,
      sla: true,
    });
  });

  it('never emphasises an ordinary priority', () => {
    expect(marks('normal', 'pending', 'running').priority).toBe(false);
    expect(marks('low', 'open', null).priority).toBe(false);
  });

  it('lets a running timer take a slot the priority did not spend', () => {
    expect(marks('normal', 'pending', 'running')).toEqual({
      priority: false,
      status: true,
      sla: true,
    });
  });

  /** The column on the left has just said it — 0001's status vocabulary. */
  it('stays quiet about a status the filter already names', () => {
    expect(
      marks('normal', 'resolved', 'met', { status: 'resolved', priority: undefined }).status,
    ).toBe(false);
    expect(
      marks('normal', 'resolved', 'met', { status: 'closed', priority: undefined }).status,
    ).toBe(true);
  });

  it('stays quiet about a priority the filter already names', () => {
    expect(marks('high', 'open', null, { status: undefined, priority: 'high' }).priority).toBe(
      false,
    );
    expect(marks('urgent', 'open', null, { status: undefined, priority: 'high' }).priority).toBe(
      true,
    );
  });

  it('spends nothing on a ticket with no timer at all', () => {
    expect(marks('normal', 'open', null)).toEqual({
      priority: false,
      status: false,
      sla: false,
    });
  });
});
