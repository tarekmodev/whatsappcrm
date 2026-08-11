import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { InternalNoteResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { InternalNotesPanel, InternalNotesPanelSkeleton } from './InternalNotesPanel';

/**
 * TAR-20's fourth acceptance criterion: internal notes are visible only to
 * agents and never sent to the customer.
 *
 * The guarantee is structural — notes are a separate entity and no send path can
 * reach one — but it is invisible to the person typing, so the panel has to say
 * it. That is what these assert.
 *
 * The server action is stubbed: this is about what the panel renders, not about
 * the round trip.
 */

vi.mock('@/features/inbox/inbox.actions', () => ({
  addInternalNoteAction: () => Promise.resolve({ status: 'success', data: undefined }),
}));

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';
const AMINA_ID = '0192f001-0000-7000-8000-000000000101';
const PRIYA_ID = '0192f001-0000-7000-8000-000000000102';

const NOTES: InternalNoteResponse[] = [
  {
    id: '0192f008-0000-7000-8000-000000000801',
    conversationId: CONVERSATION_ID,
    authorUserId: PRIYA_ID,
    body: 'Refund already approved — no need to escalate.',
    mentionedUserIds: [AMINA_ID],
    createdAt: '2026-08-10T08:50:00.000Z',
  },
];

const NAMES = new Map([
  [AMINA_ID, 'Amina Haddad'],
  [PRIYA_ID, 'Priya Raman'],
]);

function renderPanel(canWrite: boolean, notes: InternalNoteResponse[] = NOTES) {
  return render(
    <ToastProvider>
      <InternalNotesPanel
        conversationId={CONVERSATION_ID}
        notes={notes}
        authorNames={NAMES}
        canWrite={canWrite}
      />
    </ToastProvider>,
  );
}

describe('InternalNotesPanel', () => {
  it('says the customer never sees these, above the list and on the field', () => {
    renderPanel(true);

    // Twice on purpose: once as a banner, once as the composer's own hint, so
    // the guarantee does not depend on having scrolled up.
    expect(screen.getAllByText(content.notes.privacyNotice)).toHaveLength(2);
  });

  it('renders each note with its author and anyone it mentions, by name', () => {
    renderPanel(true);

    expect(screen.getByText('Refund already approved — no need to escalate.')).toBeInTheDocument();
    expect(screen.getByText('Priya Raman')).toBeInTheDocument();
    expect(screen.getByText(content.notes.mentioned('Amina Haddad'))).toBeInTheDocument();
    expect(screen.queryByText(PRIYA_ID)).not.toBeInTheDocument();
  });

  it('falls back to a neutral label rather than printing an unresolved id', () => {
    render(
      <ToastProvider>
        <InternalNotesPanel
          conversationId={CONVERSATION_ID}
          notes={NOTES}
          authorNames={new Map()}
          canWrite={false}
        />
      </ToastProvider>,
    );

    expect(screen.getByText(content.notes.authorUnknown)).toBeInTheDocument();
    expect(screen.queryByText(PRIYA_ID)).not.toBeInTheDocument();
  });

  it('renders no composer at all for a principal without conversation:note', () => {
    renderPanel(false);

    expect(screen.queryByRole('button', { name: content.notes.addSubmit })).not.toBeInTheDocument();
    // Not a disabled field either — the route to the action is simply absent.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('explains an empty panel rather than leaving it blank', () => {
    renderPanel(true, []);

    expect(screen.getByText(content.notes.emptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.notes.emptyBody)).toBeInTheDocument();
  });
});

describe('InternalNotesPanelSkeleton', () => {
  it('announces the load once and keeps the privacy notice in place', () => {
    render(<InternalNotesPanelSkeleton />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    // Present in both states, so the swap does not shift the panel — and the
    // guarantee is on screen even while the notes are loading.
    expect(screen.getByText(content.notes.privacyNotice)).toBeInTheDocument();
  });
});
