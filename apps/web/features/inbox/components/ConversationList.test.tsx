import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { ConversationList, ConversationListSkeleton } from './ConversationList';
import type { ClaimContext, InboxListQuery } from './ConversationRow';

// The column header's sort menu is a MenuButton, which closes on route change.
vi.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
}));

vi.mock('@/features/inbox/inbox.actions', () => ({
  claimConversationAction: () => Promise.resolve({ status: 'success', data: {} }),
  releaseConversationAction: () => Promise.resolve({ status: 'success', data: {} }),
}));

/**
 * TAR-20's first acceptance criterion in the list: a conversation nobody has
 * claimed is visible and says so, and opening one is a real link carrying the
 * filters — so a copied URL and the back button reproduce the same view.
 */

const CONTACT: ConversationResponse['contact'] = {
  id: '0192f003-0000-7000-8000-000000000301',
  phone: '+966501234567',
  waProfileName: 'Fatima Al-Zahra',
  displayName: 'Fatima Al-Zahra',
  email: null,
  tags: [],
  customFields: {},
  lastContactedAt: null,
  optedOutAt: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-08-09T09:15:00.000Z',
};

const ASSIGNED_ID = '0192f004-0000-7000-8000-000000000401';
const UNCLAIMED_ID = '0192f004-0000-7000-8000-000000000404';
const AMINA_ID = '0192f001-0000-7000-8000-000000000101';
const BILLING_ID = '0192f002-0000-7000-8000-000000000201';

function conversation(overrides: Partial<ConversationResponse>): ConversationResponse {
  return {
    id: ASSIGNED_ID,
    contact: CONTACT,
    whatsappAccountId: '0192f005-0000-7000-8000-000000000501',
    status: 'open',
    assignedUserId: null,
    assignedTeamId: null,
    ticketId: null,
    unreadCount: 0,
    serviceWindowExpiresAt: null,
    botHandling: false,
    botState: 'off',
    lastMessagePreview: null,
    lastMessageAt: '2026-08-10T08:45:00.000Z',
    createdAt: '2026-08-09T14:00:00.000Z',
    updatedAt: '2026-08-10T08:45:00.000Z',
    ...overrides,
  };
}

const LIANG_ID = '0192f001-0000-7000-8000-000000000104';
const NAMES = new Map([[AMINA_ID, 'Amina Haddad']]);
const TEAMS = new Map([[BILLING_ID, 'Billing']]);
const QUERY = { scope: 'all', status: 'open', sort: 'newest' } as const;

function renderList({
  conversations,
  claim = null,
  selectedId = null,
  query = QUERY,
  canManageChannels = false,
  hasMore = false,
}: {
  conversations: readonly ConversationResponse[];
  claim?: ClaimContext | null;
  selectedId?: string | null;
  query?: InboxListQuery;
  canManageChannels?: boolean;
  hasMore?: boolean;
}) {
  return render(
    <ToastProvider>
      <ConversationList
        conversations={conversations}
        hasMore={hasMore}
        userNames={NAMES}
        teamNames={TEAMS}
        query={query}
        selectedId={selectedId}
        claim={claim}
        canManageChannels={canManageChannels}
      />
    </ToastProvider>,
  );
}

/**
 * A row link's accessible name: the contact, then whatever the row is saying in
 * shape and colour alone. Composed here the way the row composes it, so a test
 * that looks a row up by name cannot drift from what the row is called.
 */
function rowName(...marks: readonly string[]): string {
  return [content.inbox.openConversation('Fatima Al-Zahra'), ...marks].join(', ');
}

describe('ConversationList', () => {
  it('opens each conversation through a link that carries the current filters', () => {
    renderList({ conversations: [conversation({})] });

    const link = screen.getByRole('link', { name: rowName(content.inbox.unclaimed) });

    expect(link).toHaveAttribute(
      'href',
      `/inbox?scope=all&status=open&conversation=${ASSIGNED_ID}`,
    );
  });

  /**
   * TAR-517: at `--size-row-list` a row reports unread as a count circle and
   * selection as an accent bar, both of which are shape and colour and nothing
   * else. The link's own name is what carries them for anyone who sees neither.
   */
  it('names each row by its contact and everything the row shows in colour alone', () => {
    renderList({ conversations: [conversation({ unreadCount: 2 })] });

    expect(
      screen.getByRole('link', {
        name: rowName(content.inbox.unreadSummary(2), content.inbox.unclaimed),
      }),
    ).toBeInTheDocument();
  });

  it('marks the open conversation for assistive technology, not only in colour', () => {
    renderList({
      conversations: [conversation({}), conversation({ id: UNCLAIMED_ID })],
      selectedId: ASSIGNED_ID,
    });

    const links = screen.getAllByRole('link');

    expect(links[0]).toHaveAttribute('aria-current', 'true');
    expect(links[1]).not.toHaveAttribute('aria-current');
  });

  it('says which conversations nobody has claimed', () => {
    renderList({ conversations: [conversation({})] });

    expect(screen.getByText(content.inbox.unclaimed)).toBeInTheDocument();
  });

  it('resolves the assignee and the routed team rather than rendering raw ids', () => {
    renderList({
      conversations: [
        conversation({ assignedUserId: AMINA_ID, assignedTeamId: BILLING_ID, unreadCount: 2 }),
      ],
    });

    // Both holders are avatars since TAR-514, so the name they stand for is
    // what a screen reader hears rather than what a pill spells out.
    expect(screen.getByText(content.inbox.assignedTo('Amina Haddad'))).toBeInTheDocument();
    expect(screen.getByText(content.inbox.assignedToTeam('Billing'))).toBeInTheDocument();
    // And the unread count is a count, not the sentence "2 unread" in a pill.
    expect(screen.getByText(content.inbox.unreadUnit).parentElement).toHaveTextContent('2');
    expect(screen.queryByText(AMINA_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(content.inbox.unclaimed)).not.toBeInTheDocument();
  });

  it('still reports a hold whose holder the directory could not name', () => {
    // The directory read is one page of users. Dropping the badge made a thread
    // somebody is working look like one nobody had touched.
    renderList({ conversations: [conversation({ assignedUserId: LIANG_ID })] });

    expect(screen.getByText(content.inbox.assignedToUnresolved)).toBeInTheDocument();
    expect(screen.queryByText(content.inbox.unclaimed)).not.toBeInTheDocument();
    expect(screen.queryByText(LIANG_ID)).not.toBeInTheDocument();
  });

  /**
   * TAR-515: three answers, not one. An empty list used to say "no conversations
   * here yet" whether nothing had ever arrived, a filter was empty, or a search
   * had just matched nothing — and the last of those reads as a broken search.
   */
  it('says the workspace has no conversations only on the unfiltered view', () => {
    renderList({
      conversations: [],
      query: { scope: 'all', status: undefined, sort: 'newest' },
      canManageChannels: true,
    });

    expect(screen.getByText(content.inbox.emptyHeading)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: content.inbox.emptyConnectAction }),
    ).toBeInTheDocument();
  });

  it('offers no way to connect a number to a principal who may not', () => {
    renderList({ conversations: [], query: { scope: 'all', status: undefined, sort: 'newest' } });

    expect(screen.getByText(content.inbox.emptyHeading)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: content.inbox.emptyConnectAction })).toBeNull();
  });

  it('names the filter that is empty, and offers to widen it', () => {
    renderList({
      conversations: [],
      query: { scope: 'assigned', status: undefined, sort: 'newest' },
    });

    expect(
      screen.getByText(content.inbox.filteredEmptyHeading(content.inbox.filterAssigned)),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: content.inbox.filteredEmptyAction }),
    ).toBeInTheDocument();
  });

  it('falls back to unnamed copy for a filter combination no entry names', () => {
    renderList({
      conversations: [],
      query: { scope: 'unassigned', status: 'resolved', sort: 'newest' },
    });

    expect(screen.getByText(content.inbox.filteredEmptyUnnamedHeading)).toBeInTheDocument();
  });

  it('quotes a search back and offers to clear it', () => {
    renderList({
      conversations: [],
      query: { scope: 'all', status: 'open', q: '+971 50', sort: 'newest' },
    });

    expect(screen.getByText(content.search.emptyHeading('+971 50'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: content.search.clear })).toBeInTheDocument();
  });
});

/**
 * TAR-71's scope puts the claim on the list as well as the thread, so picking
 * work out of the shared pool does not cost one thread-open per conversation.
 */
describe('ConversationList — claiming from the list', () => {
  /** A supervisor: both directions of a hold change. */
  const supervisor: ClaimContext = { currentUserId: AMINA_ID, canClaim: true, canAssign: true };
  /** An agent since TAR-186: may take what nobody holds, and nothing else. */
  const agent: ClaimContext = { currentUserId: AMINA_ID, canClaim: true, canAssign: false };

  it('offers no control at all to a principal holding neither permission', () => {
    renderList({ conversations: [conversation({})], claim: null });

    // Named rather than 'any button': the column's own header carries a sort
    // control, which is not a row action and is there for every principal.
    expect(screen.queryByRole('button', { name: /claim|release|take over/i })).toBeNull();
  });

  it('offers a claim on an unclaimed row', () => {
    renderList({ conversations: [conversation({})], claim: supervisor });

    expect(
      screen.getByRole('button', { name: content.inbox.claimAria('Fatima Al-Zahra') }),
    ).toBeInTheDocument();
  });

  it('offers that claim to an agent too — the shared inbox is theirs to pull from', () => {
    renderList({ conversations: [conversation({})], claim: agent });

    expect(
      screen.getByRole('button', { name: content.inbox.claimAria('Fatima Al-Zahra') }),
    ).toBeInTheDocument();
  });

  it('offers a release on a row the reader already holds', () => {
    renderList({
      conversations: [conversation({ assignedUserId: AMINA_ID })],
      claim: supervisor,
    });

    expect(
      screen.getByRole('button', { name: content.inbox.releaseAria('Fatima Al-Zahra') }),
    ).toBeInTheDocument();
  });

  it('offers an agent no way to take a row off a colleague', () => {
    // `conversation:assign` is what a take-over needs, and an agent does not
    // hold it. The API refuses the write too; this is the control not being
    // there in the first place.
    renderList({ conversations: [conversation({ assignedUserId: LIANG_ID })], claim: agent });

    expect(screen.queryByRole('button', { name: /claim|release|take over/i })).toBeNull();
  });

  it('offers a take-over, never a claim, on a row somebody else holds', () => {
    renderList({
      conversations: [conversation({ assignedUserId: LIANG_ID })],
      claim: supervisor,
    });

    expect(
      screen.getByRole('button', {
        name: content.inbox.takeOverAria('Fatima Al-Zahra', content.inbox.unresolvedHolder),
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.inbox.claimAria('Fatima Al-Zahra') }),
    ).toBeNull();
  });

  it('keeps the claim control out of the row’s link, so a click on it does not navigate', () => {
    renderList({ conversations: [conversation({})], claim: supervisor });

    const button = screen.getByRole('button', {
      name: content.inbox.claimAria('Fatima Al-Zahra'),
    });

    // A button inside an anchor is invalid and behaves differently in every
    // browser; the stretched-link pattern keeps them siblings.
    expect(button.closest('a')).toBeNull();
  });
});

/**
 * TAR-517's list chrome: how many rows are in front of you, and what order they
 * are in — the two things the column could not say for itself.
 */
describe('ConversationList — the column header', () => {
  it('counts the rows it is showing', () => {
    renderList({ conversations: [conversation({}), conversation({ id: UNCLAIMED_ID })] });

    expect(screen.getByText(content.inbox.conversationCount(2))).toBeInTheDocument();
  });

  it('says the count is a floor when there is another page behind it', () => {
    // The list read carries no `count(*)`, so the honest answer for a page with
    // a cursor after it is "at least this many" — never a total it never had.
    renderList({ conversations: [conversation({})], hasMore: true });

    expect(screen.getByText(content.inbox.conversationCountAtLeast(1))).toBeInTheDocument();
    expect(screen.queryByText(content.inbox.conversationCount(1))).toBeNull();
  });

  it('puts the order in the URL, keeping the filters and the open thread', () => {
    renderList({ conversations: [conversation({})], selectedId: ASSIGNED_ID });
    fireEvent.click(screen.getByRole('button', { name: content.inbox.sortLabel }));

    expect(screen.getByRole('link', { name: content.inbox.sorts.oldest })).toHaveAttribute(
      'href',
      `/inbox?scope=all&status=open&conversation=${ASSIGNED_ID}&sort=oldest`,
    );
  });

  it('leaves the default order out of the URL rather than writing it on every link', () => {
    renderList({ conversations: [conversation({})] });
    fireEvent.click(screen.getByRole('button', { name: content.inbox.sortLabel }));

    expect(screen.getByRole('link', { name: content.inbox.sorts.newest })).toHaveAttribute(
      'href',
      '/inbox?scope=all&status=open',
    );
  });

  it('offers no header over an empty list', () => {
    // "0 conversations" over an empty state that has just explained itself says
    // the same thing twice, and a sort control over nothing orders nothing.
    renderList({ conversations: [], query: { scope: 'all', status: undefined, sort: 'newest' } });

    expect(screen.queryByRole('button', { name: content.inbox.sortLabel })).toBeNull();
  });
});

describe('ConversationListSkeleton', () => {
  it('announces the load exactly once, politely', () => {
    render(<ConversationListSkeleton query={QUERY} conversationId={null} />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.inbox.loadingConversations);
  });

  it('hides its placeholder rows from assistive technology', () => {
    const { container } = render(<ConversationListSkeleton query={QUERY} conversationId={null} />);

    expect(container.querySelector('ul')).toHaveAttribute('aria-hidden', 'true');
  });
});
