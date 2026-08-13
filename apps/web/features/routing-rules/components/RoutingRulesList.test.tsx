import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AssignmentRuleResponse, Tag, TeamResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { RoutingRuleVocabulary } from '../presentation';
import { RoutingRulesList, RoutingRulesListSkeleton } from './RoutingRulesList';

/**
 * TAR-289's permission and ordering criteria at the row level: a principal
 * without `assignment_rule:write` is rendered no route to a write at all — not a
 * disabled button — and the order the engine evaluates in is the order on screen.
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/settings/assignment' }));

const TEAM: TeamResponse = {
  id: '0192f002-0000-7000-8000-000000000201',
  name: 'Billing',
  description: null,
  memberUserIds: [],
  createdAt: '2026-07-02T10:10:00.000Z',
};

const TAG: Tag = { id: '0192f009-0000-7000-8000-000000000901', name: 'VIP', color: '#7c3aed' };

const VOCABULARY: RoutingRuleVocabulary = {
  teams: [TEAM],
  users: [],
  tags: [TAG],
  customFields: [],
};

function rule(overrides: Partial<AssignmentRuleResponse> = {}): AssignmentRuleResponse {
  return {
    id: '0192f00b-0000-7000-8000-000000000b01',
    name: 'Billing keywords',
    position: 0,
    isActive: true,
    conditions: [{ type: 'keyword', match: 'any', values: ['billing'] }],
    target: { kind: 'team', teamId: TEAM.id },
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
    ...overrides,
  };
}

const SECOND = rule({
  id: '0192f00b-0000-7000-8000-000000000b02',
  name: 'VIP onboarding',
  position: 1,
  conditions: [{ type: 'tag', match: 'any', tagIds: [TAG.id] }],
});

function renderList(rules: readonly AssignmentRuleResponse[], canWrite: boolean) {
  return render(
    <ToastProvider>
      <RoutingRulesList rules={rules} vocabulary={VOCABULARY} canWrite={canWrite} />
    </ToastProvider>,
  );
}

describe('RoutingRulesList', () => {
  it('renders each rule with its place in the order, its match and its target', () => {
    renderList([rule(), SECOND], true);

    expect(screen.getByText('Billing keywords')).toBeInTheDocument();
    expect(screen.getByText(content.routingRules.orderPosition(1))).toBeInTheDocument();
    expect(screen.getByText(content.routingRules.orderPosition(2))).toBeInTheDocument();
    expect(screen.getByText(/the message mentions billing/)).toBeInTheDocument();
    expect(screen.getByText(/the contact is tagged VIP/)).toBeInTheDocument();
    // Both rules route to the same team, so both cards name it.
    expect(screen.getAllByText(/Billing team/)).toHaveLength(2);
  });

  it('is an ordered list, so the evaluation order is conveyed without a column for it', () => {
    renderList([rule(), SECOND], true);

    const list = screen.getByRole('list', { name: content.routingRules.listLabel });

    expect(list.tagName).toBe('OL');
    // Its own children, not every `li` on screen: each card also holds the
    // bulleted list of its conditions.
    expect(list.children).toHaveLength(2);
  });

  it('names every row action after the rule it acts on', () => {
    renderList([rule(), SECOND], true);

    expect(
      screen.getByRole('button', { name: content.routingRules.editRuleAria('Billing keywords') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.routingRules.deleteRuleAria('Billing keywords') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.routingRules.disableAria('Billing keywords') }),
    ).toBeInTheDocument();
  });

  it('renders no write control at all for a read-only principal', () => {
    renderList([rule(), SECOND], false);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('disables the move that would take a rule off the end of the list', () => {
    renderList([rule(), SECOND], true);

    expect(
      screen.getByRole('button', { name: content.routingRules.moveUpAria('Billing keywords') }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: content.routingRules.moveDownAria('VIP onboarding') }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: content.routingRules.moveDownAria('Billing keywords') }),
    ).toBeEnabled();
  });

  it('will not offer to enable a rule whose target was removed, and says why', () => {
    renderList([rule({ isActive: false, target: null, name: 'Escalations' })], true);

    expect(screen.getByText(content.routingRules.targetMissing)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.routingRules.enableAria('Escalations') }),
    ).toBeDisabled();
  });

  it('explains an empty list rather than rendering a blank panel', () => {
    renderList([], true);

    expect(screen.getByText(content.routingRules.emptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.routingRules.emptyBody)).toBeInTheDocument();
  });
});

describe('RoutingRulesListSkeleton', () => {
  it('announces the load exactly once, politely', () => {
    render(<RoutingRulesListSkeleton />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.routingRules.loading);
  });

  it('mirrors the loaded list’s own element, so the swap does not reflow it', () => {
    const { unmount } = renderList([rule(), SECOND], true);
    const loaded = screen.getByRole('list', { name: content.routingRules.listLabel });

    expect(loaded.tagName).toBe('OL');
    unmount();

    render(<RoutingRulesListSkeleton />);

    expect(document.querySelectorAll('ol > li')).toHaveLength(3);
  });
});
