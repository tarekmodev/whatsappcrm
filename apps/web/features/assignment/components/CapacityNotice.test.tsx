import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { capacityRemedy, toAgentCapacityRows, type AgentCapacityReport } from '../capacity';
import { CapacityNotice } from './CapacityNotice';

/**
 * TAR-384's acceptance criterion at the placement level, settled on TAR-778: the
 * supervisor who sees "everyone at capacity" gets the fact and the remedy above
 * the queue, and the reader who cannot act still gets the fact.
 *
 * The three things this notice must never do are what most of these assert — claim
 * something about tickets it cannot see, offer a button to somebody the API will
 * refuse, and tell a supervisor to go and ask a supervisor.
 */

const AGENT: UserResponse = {
  id: '0192f001-0000-7000-8000-000000000101',
  email: 'amina@northwind.example',
  displayName: 'Amina Haddad',
  avatarUrl: null,
  role: 'agent',
  status: 'active',
  availability: 'available',
  teamIds: [],
  occupiesSeat: true,
  lastSeenAt: null,
  security: null,
  assignmentCapacity: {
    maxConcurrentTickets: 2,
    effectiveMaxConcurrentTickets: 2,
    activeTicketCount: 2,
  },
  createdAt: '2026-07-02T10:00:00.000Z',
};

const REPORT: AgentCapacityReport = {
  rows: toAgentCapacityRows([AGENT]),
  workspaceDefault: 5,
  hasMore: false,
};

function trigger(): HTMLElement | null {
  return screen.queryByRole('button', { name: content.assignment.raiseLimit });
}

describe('CapacityNotice', () => {
  it('states how many rows on the page are stuck on a limit, and offers the remedy', () => {
    render(
      <CapacityNotice
        atCapacityCount={2}
        isFilteredToCapacity={false}
        remedy={capacityRemedy(true, REPORT)}
      />,
    );

    expect(screen.getByText(content.assignment.capacityNoticeCount(2))).toBeInTheDocument();
    expect(screen.getByText(content.assignment.capacityNoticeConsequence)).toBeInTheDocument();
    expect(trigger()).toBeInTheDocument();
  });

  /**
   * One at-capacity row is the common case on this queue, so the plural is not a
   * corner: "1 of these are waiting" would ship the day the notice did.
   */
  it('says it in the singular for a single row', () => {
    render(
      <CapacityNotice
        atCapacityCount={1}
        isFilteredToCapacity={false}
        remedy={capacityRemedy(true, REPORT)}
      />,
    );

    expect(screen.getByText(/^1 of these is waiting/)).toBeInTheDocument();
  });

  /**
   * Under the "Everyone at capacity" pill the count is the whole list, so a
   * number above it is a riddle rather than a fact.
   */
  it('drops the count when the list is already filtered to this reason', () => {
    render(
      <CapacityNotice
        atCapacityCount={3}
        isFilteredToCapacity
        remedy={capacityRemedy(true, REPORT)}
      />,
    );

    expect(screen.getByText(content.assignment.capacityNoticeCountFiltered)).toBeInTheDocument();
    expect(screen.queryByText(content.assignment.capacityNoticeCount(3))).not.toBeInTheDocument();
  });

  /**
   * Per 0001 an action a role cannot perform is not offered — omitted, never
   * disabled. The fact stays, because knowing why the queue is stuck is what
   * tells somebody whether to wait or to escalate.
   */
  it('keeps the fact and drops the button for a reader who may not act', () => {
    render(
      <CapacityNotice
        atCapacityCount={2}
        isFilteredToCapacity={false}
        remedy={capacityRemedy(false, null)}
      />,
    );

    expect(screen.getByText(content.assignment.capacityNoticeCount(2))).toBeInTheDocument();
    expect(screen.getByText(content.assignment.capacityNoticeAskSupervisor)).toBeInTheDocument();
    expect(trigger()).not.toBeInTheDocument();
  });

  /**
   * A permitted caller the console cannot read limits for is not the same absence
   * as a refused one, and neither of the other two sentences survives here:
   * telling a supervisor to ask a supervisor is nonsense, and describing what
   * raising a limit does is a promise about a control this reader has not been
   * given. Its own sentence, and still no button.
   */
  it('says why there is nothing to change, rather than borrowing another reader’s sentence', () => {
    render(
      <CapacityNotice
        atCapacityCount={2}
        isFilteredToCapacity={false}
        remedy={capacityRemedy(true, null)}
      />,
    );

    expect(screen.getByText(content.assignment.capacityNoticeUnavailable)).toBeInTheDocument();
    expect(
      screen.queryByText(content.assignment.capacityNoticeAskSupervisor),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(content.assignment.capacityNoticeConsequence),
    ).not.toBeInTheDocument();
    expect(trigger()).not.toBeInTheDocument();
  });

  /** The count is the fact, and it is worth knowing to a reader who cannot act on it. */
  it('keeps the count when the limits cannot be read', () => {
    render(
      <CapacityNotice
        atCapacityCount={2}
        isFilteredToCapacity={false}
        remedy={capacityRemedy(true, null)}
      />,
    );

    expect(screen.getByText(content.assignment.capacityNoticeCount(2))).toBeInTheDocument();
  });

  /**
   * On a queue stuck for any other reason a higher limit changes nothing, and a
   * remedy that does not apply sends a supervisor to fix the wrong thing.
   */
  it('renders nothing when no row on the page is at capacity', () => {
    const { container } = render(
      <CapacityNotice
        atCapacityCount={0}
        isFilteredToCapacity={false}
        remedy={capacityRemedy(true, REPORT)}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
