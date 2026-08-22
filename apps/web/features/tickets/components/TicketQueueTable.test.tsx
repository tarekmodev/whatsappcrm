import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { TicketResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { TicketQueueParams } from '@/features/tickets/ticket-params';
import { TicketQueueTable } from './TicketQueueTable';

/**
 * What a queue row says, and how loudly (TAR-520). The chip budget itself is
 * `ticket-chips.test.ts`; this is the wiring — that the losing mark keeps its
 * word, that a subject-less ticket names itself once, and that a holder arrives
 * with a face.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';

const USER_NAMES = new Map([[USER_ID, 'Amina Haddad']]);
const TEAM_NAMES = new Map([[TEAM_ID, 'Billing']]);

const DEFAULT_PARAMS: TicketQueueParams = {
  scope: 'all',
  status: undefined,
  priority: undefined,
  isOverdueOnly: false,
};

function ticket(overrides: Partial<TicketResponse> = {}): TicketResponse {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    number: 1042,
    subject: 'July invoice never arrived',
    status: 'open',
    priority: 'urgent',
    conversationId: null,
    contactId: null,
    assignedUserId: USER_ID,
    assignedTeamId: null,
    routingState: 'routed',
    deferredReason: null,
    routingDeferredSince: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    resolvedAt: null,
    closedAt: null,
    sla: {
      firstResponseState: 'breached',
      firstResponseDueAt: '2026-08-01T11:00:00.000Z',
      resolutionState: 'not_applicable',
      resolutionDueAt: null,
    },
    ...overrides,
  } as TicketResponse;
}

function renderQueue(tickets: TicketResponse[], params: TicketQueueParams = DEFAULT_PARAMS) {
  return render(
    <TicketQueueTable
      tickets={tickets}
      userNames={USER_NAMES}
      teamNames={TEAM_NAMES}
      params={params}
    />,
  );
}

function loudMarksIn(row: HTMLElement): string[] {
  return [...row.querySelectorAll('[data-variant="subtle"]')].map((node) => node.textContent ?? '');
}

describe('TicketQueueTable', () => {
  it('carries at most two loud marks on a row, and keeps the rest as words', () => {
    const { container } = renderQueue([ticket()]);
    const row = container.querySelector('tbody tr') as HTMLElement;

    expect(loudMarksIn(row)).toEqual([content.ticketPriorities.urgent, content.sla.stateBreached]);
    // Dropped from the pills, not from the row: the cell still says "Open".
    expect(within(row).getByText(content.ticketStatuses.open)).toBeInTheDocument();
  });

  it('names a ticket with no subject once, not twice', () => {
    renderQueue([ticket({ subject: null })]);

    expect(screen.getByText(content.tickets.noSubject)).toBeInTheDocument();
    expect(screen.queryByText(content.tickets.untitled(1042))).not.toBeInTheDocument();
    expect(screen.getAllByText(content.tickets.reference(1042))).toHaveLength(1);
  });

  it('puts a face beside the person holding a ticket', () => {
    const { container } = renderQueue([ticket()]);

    expect(screen.getByText('Amina Haddad')).toBeInTheDocument();
    expect(container.querySelector('[data-held="true"]')).not.toBeNull();
  });

  it('gives an unassigned ticket no avatar', () => {
    const { container } = renderQueue([ticket({ assignedUserId: null, assignedTeamId: null })]);

    expect(screen.getByText(content.common.unassigned)).toBeInTheDocument();
    expect(container.querySelector('[data-held="true"]')).toBeNull();
  });

  it('stays quiet about a status the filter has already named', () => {
    const { container } = renderQueue([ticket({ status: 'resolved', priority: 'normal' })], {
      ...DEFAULT_PARAMS,
      status: 'resolved',
    });
    const row = container.querySelector('tbody tr') as HTMLElement;

    expect(loudMarksIn(row)).toEqual([content.sla.stateBreached]);
    expect(within(row).getByText(content.ticketStatuses.resolved)).toBeInTheDocument();
  });
});
