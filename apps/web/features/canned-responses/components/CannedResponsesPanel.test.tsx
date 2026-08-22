import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CANNED_RESPONSE_LIMITS, type CannedResponseResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { CannedResponsesPanel } from './CannedResponsesPanel';

/**
 * The card around the table, and the one piece of behaviour that lives only
 * here: what the panel does when the workspace is at its cap.
 *
 * Worth its own file rather than a case in the table's, because the table never
 * sees `perTenant` — the create trigger and the notice are the panel's, and a
 * regression that dropped or inverted the check would otherwise ship green.
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

/**
 * Rendering a full library is the one slow thing in this file, and the default
 * 5s budget is not enough for it under a loaded worker pool.
 *
 * The cost is jsdom's, not the product's: reaching the panel's at-limit branch
 * needs `perTenant` rows, and at `canManage` each row carries two buttons, so
 * the real `DataTable` builds ~1000 nodes. A browser does that in milliseconds.
 * Stated here rather than raised globally, so no other test quietly inherits a
 * budget it should not need.
 */
const FULL_LIBRARY_RENDER_TIMEOUT_MS = 20_000;

/** A library at exactly the cap the API enforces on create. */
function libraryAtLimit(): CannedResponseResponse[] {
  return Array.from({ length: CANNED_RESPONSE_LIMITS.perTenant }, (_unused, index) => ({
    ...HOURS,
    id: `0192f00c-0000-7000-8000-${String(index).padStart(12, '0')}`,
    shortcut: `/reply${String(index)}`,
    title: `Reply ${String(index)}`,
  }));
}

describe('CannedResponsesPanel', () => {
  it('offers the create trigger while the workspace has room', () => {
    render(<CannedResponsesPanel responses={[HOURS]} canManage />);

    expect(
      screen.getByRole('button', { name: content.cannedResponses.create }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        content.cannedResponses.limitReachedNotice(CANNED_RESPONSE_LIMITS.perTenant),
      ),
    ).not.toBeInTheDocument();
  });

  it(
    'withdraws the create trigger and says why once the cap is reached',
    () => {
      // Offering the button anyway and letting the request come back `conflict`
      // would tell the admin nothing about how to get out of it.
      render(<CannedResponsesPanel responses={libraryAtLimit()} canManage />);

      expect(
        screen.queryByRole('button', { name: content.cannedResponses.create }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(
          content.cannedResponses.limitReachedNotice(CANNED_RESPONSE_LIMITS.perTenant),
        ),
      ).toBeInTheDocument();
    },
    FULL_LIBRARY_RENDER_TIMEOUT_MS,
  );

  it('offers no create trigger at all to a role that may not write one', () => {
    render(<CannedResponsesPanel responses={[HOURS]} canManage={false} />);

    expect(
      screen.queryByRole('button', { name: content.cannedResponses.create }),
    ).not.toBeInTheDocument();
  });

  it(
    'keeps the cap notice to the roles that could act on it',
    () => {
      // A reader who cannot add a reply has nothing to do about a full library,
      // so the warning would be noise rather than information.
      render(<CannedResponsesPanel responses={libraryAtLimit()} canManage={false} />);

      expect(
        screen.queryByText(
          content.cannedResponses.limitReachedNotice(CANNED_RESPONSE_LIMITS.perTenant),
        ),
      ).not.toBeInTheDocument();
    },
    FULL_LIBRARY_RENDER_TIMEOUT_MS,
  );

  it('counts the library against the cap in the card description', () => {
    render(<CannedResponsesPanel responses={[HOURS]} canManage />);

    expect(
      screen.getByText(
        content.cannedResponses.listDescription(1, CANNED_RESPONSE_LIMITS.perTenant),
      ),
    ).toBeInTheDocument();
  });
});
