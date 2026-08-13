import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AssignmentRuleResponse, TeamResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { RoutingRuleVocabulary } from '../presentation';
import { RoutingRuleCard } from './RoutingRuleCard';

/**
 * When a rule's controls stand down, and why.
 *
 * The reorder endpoint cannot catch two moves racing: both payloads carry the
 * tenant's complete set with the same members, so its concurrency check passes
 * both, and the later one — computed from the order still on screen — silently
 * undoes the earlier. So the standing-down is the correctness mechanism here, not
 * a nicety, and it is worth pinning.
 */

const TEAM: TeamResponse = {
  id: '0192f002-0000-7000-8000-000000000201',
  name: 'Billing',
  description: null,
  memberUserIds: [],
  createdAt: '2026-07-02T10:10:00.000Z',
};

const VOCABULARY: RoutingRuleVocabulary = {
  teams: [TEAM],
  users: [],
  tags: [],
  customFields: [],
};

const RULE: AssignmentRuleResponse = {
  id: '0192f00b-0000-7000-8000-000000000b02',
  name: 'VIP onboarding',
  position: 1,
  isActive: true,
  conditions: [{ type: 'keyword', match: 'any', values: ['vip'] }],
  target: { kind: 'team', teamId: TEAM.id },
  createdAt: '2026-08-10T09:00:00.000Z',
  updatedAt: '2026-08-10T09:00:00.000Z',
};

function renderCard(overrides: Partial<Parameters<typeof RoutingRuleCard>[0]> = {}) {
  return render(
    <RoutingRuleCard
      rule={RULE}
      position={2}
      vocabulary={VOCABULARY}
      canWrite
      isFirst={false}
      isLast={false}
      isPending={false}
      isReordering={false}
      onMove={vi.fn()}
      onToggle={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      {...overrides}
    />,
  );
}

const copy = content.routingRules;

describe('RoutingRuleCard', () => {
  it('offers both moves to a rule in the middle of the list', () => {
    renderCard();

    expect(screen.getByRole('button', { name: copy.moveUpAria(RULE.name) })).toBeEnabled();
    expect(screen.getByRole('button', { name: copy.moveDownAria(RULE.name) })).toBeEnabled();
  });

  it('stands both moves down while a write is in flight anywhere in the list', () => {
    renderCard({ isReordering: true });

    expect(screen.getByRole('button', { name: copy.moveUpAria(RULE.name) })).toBeDisabled();
    expect(screen.getByRole('button', { name: copy.moveDownAria(RULE.name) })).toBeDisabled();
  });

  it('still disables the move that would take a rule off the end', () => {
    renderCard({ isFirst: true });

    expect(screen.getByRole('button', { name: copy.moveUpAria(RULE.name) })).toBeDisabled();
    expect(screen.getByRole('button', { name: copy.moveDownAria(RULE.name) })).toBeEnabled();
  });

  it('leaves editing and deleting reachable while a reorder settles', () => {
    // Neither is computed from the order on screen, so neither can lose the race.
    renderCard({ isReordering: true });

    expect(screen.getByRole('button', { name: copy.editRuleAria(RULE.name) })).toBeEnabled();
    expect(screen.getByRole('button', { name: copy.deleteRuleAria(RULE.name) })).toBeEnabled();
  });
});
