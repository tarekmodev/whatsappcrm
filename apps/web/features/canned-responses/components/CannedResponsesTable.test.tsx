import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { CANNED_RESPONSE_PREVIEW_LENGTH } from '../constants';
import { CannedResponsesTable } from './CannedResponsesTable';
import { CannedResponsesTableSkeleton } from './CannedResponsesTable.Skeleton';

/**
 * The admin surface behind TAR-31's second acceptance criterion, which had no
 * admin half until TAR-575. A role that cannot write a saved reply is rendered
 * no route to a mutation at all — not a disabled button, not a hidden-by-CSS one.
 */

const HOURS: CannedResponseResponse = {
  id: '0192f00c-0000-7000-8000-0000000000a1',
  shortcut: '/hours',
  title: 'Opening hours',
  body: 'We are open Sunday to Thursday, 9am to 6pm.',
  createdByUserId: '0192f00c-0000-7000-8000-0000000000b1',
  createdAt: '2026-08-11T08:00:00.000Z',
  updatedAt: '2026-08-11T08:00:00.000Z',
};

const SHIPPING: CannedResponseResponse = {
  ...HOURS,
  id: '0192f00c-0000-7000-8000-0000000000a2',
  shortcut: '/shipping',
  title: 'Delivery times',
  body: 'Standard delivery takes 3 to 5 working days.',
};

describe('CannedResponsesTable', () => {
  it('renders each reply with its shortcut, its name and its text', () => {
    render(<CannedResponsesTable responses={[HOURS]} canManage />);

    expect(screen.getByText('/hours')).toBeInTheDocument();
    expect(screen.getByText('Opening hours')).toBeInTheDocument();
    expect(screen.getByText(HOURS.body)).toBeInTheDocument();
  });

  it('renders the replies in the order it was given them', () => {
    // Ascending `shortcut` is the API's ordering, and the order an admin scans
    // for one — the table must not re-sort by name behind it.
    render(<CannedResponsesTable responses={[HOURS, SHIPPING]} canManage />);

    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);

    expect(cells.indexOf('/hours')).toBeLessThan(cells.indexOf('/shipping'));
  });

  it('cuts a long reply and says out loud that it was cut', () => {
    render(
      <CannedResponsesTable responses={[{ ...HOURS, body: 'sentence '.repeat(100) }]} canManage />,
    );

    expect(
      screen.getByText(content.cannedResponses.textTruncatedAria(CANNED_RESPONSE_PREVIEW_LENGTH)),
    ).toBeInTheDocument();
  });

  it('says nothing about truncation when the whole reply is on screen', () => {
    render(<CannedResponsesTable responses={[HOURS]} canManage />);

    expect(
      screen.queryByText(content.cannedResponses.textTruncatedAria(CANNED_RESPONSE_PREVIEW_LENGTH)),
    ).not.toBeInTheDocument();
  });

  it('names each row action after the reply it acts on', () => {
    render(<CannedResponsesTable responses={[HOURS]} canManage />);

    expect(
      screen.getByRole('button', { name: content.cannedResponses.editAria('Opening hours') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.cannedResponses.removeAria('Opening hours') }),
    ).toBeInTheDocument();
  });

  it('renders no action and no actions column for a role that may not write one', () => {
    render(<CannedResponsesTable responses={[HOURS]} canManage={false} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // The whole column is gone, not just its buttons.
    expect(
      screen.queryByRole('columnheader', { name: content.cannedResponses.columnActions }),
    ).not.toBeInTheDocument();
  });

  it('explains an empty library rather than rendering a blank panel', () => {
    render(<CannedResponsesTable responses={[]} canManage />);

    expect(screen.getByText(content.cannedResponses.emptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.cannedResponses.emptyBody)).toBeInTheDocument();
  });
});

describe('CannedResponsesTableSkeleton', () => {
  it('announces the load exactly once, politely', () => {
    render(<CannedResponsesTableSkeleton />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.cannedResponses.listLoading);
  });

  it('mirrors the loaded table’s column set, including the actions column', () => {
    const { unmount } = render(<CannedResponsesTable responses={[HOURS]} canManage />);
    const loadedColumnCount = screen.getAllByRole('columnheader').length;

    unmount();
    render(<CannedResponsesTableSkeleton canManage />);

    expect(document.querySelectorAll('th')).toHaveLength(loadedColumnCount);
  });

  it('drops the actions column when the role would not get one', () => {
    render(<CannedResponsesTableSkeleton canManage={false} />);

    // Three data columns, no actions column — matching what that role's real
    // table will render, so the swap does not shift.
    expect(document.querySelectorAll('th')).toHaveLength(3);
  });
});
