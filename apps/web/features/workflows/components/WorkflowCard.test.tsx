import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TeamResponse, WorkflowResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { WorkflowVocabulary } from '../presentation';
import { WorkflowCard } from './WorkflowCard';

/**
 * The card is where a broken reference has to become visible rather than silent
 * (ADR 0009 decision 6) and where arming has to stand down when it would be
 * refused. Both are correctness, not polish: a workflow that looks armable and
 * is not sends the supervisor to a refusal they cannot read the cause of.
 */

const TEAM: TeamResponse = {
  id: '0192f002-0000-7000-8000-000000000201',
  name: 'Billing',
  description: null,
  memberUserIds: [],
  createdAt: '2026-07-02T10:10:00.000Z',
};

const VOCABULARY: WorkflowVocabulary = { teams: [TEAM], users: [], tags: [] };

const WORKFLOW: WorkflowResponse = {
  id: '0192f010-0000-7000-8000-000000001001',
  name: 'Urgent tickets go to Billing',
  position: 0,
  isActive: false,
  brokenReason: null,
  version: 1,
  trigger: { type: 'ticket_created' },
  conditions: [{ type: 'ticket_priority', operator: 'in', values: ['urgent'] }],
  actions: [{ type: 'reassign', target: { kind: 'team', teamId: TEAM.id } }],
  references: [{ kind: 'team', id: TEAM.id, name: TEAM.name, exists: true }],
  createdAt: '2026-08-12T09:00:00.000Z',
  updatedAt: '2026-08-12T09:00:00.000Z',
};

const BROKEN: WorkflowResponse = {
  ...WORKFLOW,
  brokenReason: 'reference_removed',
  references: [{ kind: 'team', id: TEAM.id, name: null, exists: false }],
};

function renderCard(overrides: Partial<Parameters<typeof WorkflowCard>[0]> = {}) {
  return render(
    <WorkflowCard
      workflow={WORKFLOW}
      position={1}
      vocabulary={VOCABULARY}
      canWrite
      isFirst={false}
      isLast={false}
      isPending={false}
      isReordering={false}
      onMove={vi.fn()}
      onToggle={vi.fn()}
      onEdit={vi.fn()}
      onTest={vi.fn()}
      onViewRuns={vi.fn()}
      onDelete={vi.fn()}
      {...overrides}
    />,
  );
}

const copy = content.workflows;

describe('WorkflowCard', () => {
  it('reads the workflow back as a sentence rather than as ids', () => {
    renderCard();

    expect(screen.getByText(copy.summaryTriggerCreated)).toBeInTheDocument();
    expect(
      screen.getByText(copy.summaryReassign(copy.targetTeamName(TEAM.name))),
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(TEAM.id))).not.toBeInTheDocument();
  });

  it('says so when a workflow has no conditions, instead of leaving a gap', () => {
    renderCard({ workflow: { ...WORKFLOW, conditions: [] } });

    expect(screen.getByText(copy.alwaysMatches)).toBeInTheDocument();
  });

  it('surfaces a broken reference and refuses to arm the workflow', () => {
    renderCard({ workflow: BROKEN });

    expect(screen.getByText(new RegExp(copy.referenceKinds.team))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.enableAria(BROKEN.name) })).toBeDisabled();
  });

  it('arms a repaired workflow whose brokenReason has not been rewritten yet', () => {
    // `brokenReason` is derived state, not a latch (ADR 0009 decision 6, as
    // amended on TAR-399). Only a *write* rewrites the stored column, so a
    // reference that comes back on its own — a removed agent re-invited onto the
    // same row — leaves the field standing over references that all resolve. The
    // API would accept this arming request; gating on the field refused it here
    // and left the workflow permanently off.
    renderCard({ workflow: { ...WORKFLOW, brokenReason: 'reference_removed' } });

    expect(screen.getByRole('button', { name: copy.enableAria(WORKFLOW.name) })).toBeEnabled();
    expect(screen.queryByText(new RegExp(copy.referenceKinds.team))).not.toBeInTheDocument();
  });

  it('still lets a broken workflow that is on be turned off', () => {
    // Turning one *off* can never make things worse, and it is the fastest thing
    // a supervisor can do about a workflow misbehaving on live tickets.
    renderCard({ workflow: { ...BROKEN, isActive: true } });

    expect(screen.getByRole('button', { name: copy.disableAria(BROKEN.name) })).toBeEnabled();
  });

  it('stands both moves down while another row’s write is in flight', () => {
    renderCard({ isReordering: true });

    expect(screen.getByRole('button', { name: copy.moveUpAria(WORKFLOW.name) })).toBeDisabled();
    expect(screen.getByRole('button', { name: copy.moveDownAria(WORKFLOW.name) })).toBeDisabled();
  });

  it('shows a read-only principal the workflow and none of the controls', () => {
    renderCard({ canWrite: false });

    expect(screen.getByText(WORKFLOW.name)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
