import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  ONBOARDING_STEP_IDS,
  type OnboardingChecklistResponse,
  type OnboardingStep,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { OnboardingChecklist, OnboardingChecklistSkeleton } from './OnboardingChecklist';

/**
 * TAR-36's onboarding criteria at the list level: the three steps are walked
 * through, each one can be skipped and come back, and the URL is what says where
 * the admin got to — so a refresh and the back button reproduce the same view.
 */

const TENANT_ID = '0192f000-0000-7000-8000-00000000a001';
const AT = '2026-08-15T09:00:00.000Z';
const copy = content.onboarding;

/** Statuses in `ONBOARDING_STEP_IDS` order; anything unnamed is still pending. */
function checklist(...statuses: readonly OnboardingStepStatus[]): OnboardingChecklistResponse {
  const steps: OnboardingStep[] = ONBOARDING_STEP_IDS.map((id, index) => {
    const status = statuses[index] ?? 'pending';

    return {
      id,
      status,
      completedAt: status === 'completed' ? AT : null,
      skippedAt: status === 'skipped' ? AT : null,
    };
  });

  return { tenantId: TENANT_ID, steps, completedAt: null, updatedAt: AT };
}

/**
 * The skip control is the checklist's one client island and announces its outcome
 * through the shared toast system, so the list has to render inside the provider
 * the app wraps it in.
 */
function renderChecklist(
  data: OnboardingChecklistResponse,
  requestedStepId?: OnboardingStepId,
): void {
  render(
    <ToastProvider>
      <OnboardingChecklist checklist={data} requestedStepId={requestedStepId} />
    </ToastProvider>,
  );
}

describe('OnboardingChecklist', () => {
  it('walks the admin through all three steps', () => {
    renderChecklist(checklist());

    for (const stepId of ONBOARDING_STEP_IDS) {
      expect(
        screen.getByRole('heading', { name: copy.steps[stepId].title, level: 3 }),
      ).toBeInTheDocument();
    }
  });

  it('opens the first pending step when the URL names none', () => {
    renderChecklist(checklist('completed'));

    // Step one is done, so the walkthrough moves on rather than reopening it.
    expect(screen.getByText(copy.steps.invite_agents.detail)).toBeInTheDocument();
    expect(screen.queryByText(copy.steps.connect_whatsapp.detail)).not.toBeInTheDocument();
  });

  it('opens the step the URL names, so a shared link reproduces the view', () => {
    renderChecklist(checklist(), 'set_branding');

    expect(screen.getByText(copy.steps.set_branding.detail)).toBeInTheDocument();
    expect(screen.queryByText(copy.steps.connect_whatsapp.detail)).not.toBeInTheDocument();
  });

  it('makes every closed step a link, so opening one is a navigation', () => {
    renderChecklist(checklist());

    expect(screen.getByRole('link', { name: copy.steps.invite_agents.title })).toHaveAttribute(
      'href',
      '/onboarding?step=invite_agents',
    );
    // The open one is a heading, not a link to the page you are already on.
    expect(
      screen.queryByRole('link', { name: copy.steps.connect_whatsapp.title }),
    ).not.toBeInTheDocument();
  });

  it('says each step’s status in words, never in colour alone', () => {
    renderChecklist(checklist('completed', 'skipped', 'pending'));

    expect(screen.getByText(copy.statuses.completed)).toBeInTheDocument();
    expect(screen.getByText(copy.statuses.skipped)).toBeInTheDocument();
    expect(screen.getByText(copy.statuses.pending)).toBeInTheDocument();
  });

  it('offers a skip on a pending step', () => {
    renderChecklist(checklist());

    expect(screen.getByRole('button', { name: copy.skip })).toBeInTheDocument();
  });

  it('offers the undo on a skipped step, which is what makes it returnable', () => {
    renderChecklist(checklist('skipped'), 'connect_whatsapp');

    expect(screen.getByRole('button', { name: copy.unskip })).toBeInTheDocument();
  });

  it('offers no skip on a completed step', () => {
    renderChecklist(checklist('completed'), 'connect_whatsapp');

    expect(screen.queryByRole('button', { name: copy.skip })).not.toBeInTheDocument();
  });

  it('links the open step to the surface that does the work', () => {
    renderChecklist(checklist());

    expect(screen.getByRole('link', { name: copy.steps.connect_whatsapp.action })).toHaveAttribute(
      'href',
      '/settings/whatsapp',
    );
  });

  it('says branding has no editor yet instead of linking to a page that does not exist', () => {
    renderChecklist(checklist(), 'set_branding');

    expect(screen.getByText(copy.unavailableNotice)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: copy.steps.set_branding.action }),
    ).not.toBeInTheDocument();
  });

  it('reports progress as a value a person can read, not a bare number', () => {
    renderChecklist(checklist('completed', 'skipped'));

    // A skipped step counts as resolved: a meter that can never fill reads as an
    // outstanding task rather than as a decision already made.
    expect(screen.getByRole('progressbar', { name: copy.progressLabel })).toHaveAttribute(
      'aria-valuetext',
      copy.progressCount(2, 3),
    );
  });

  it('keeps the list on screen once everything is resolved, so a skip can be undone', () => {
    renderChecklist(checklist('completed', 'skipped', 'skipped'));

    expect(screen.getByText(copy.completeNotice)).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('OnboardingChecklistSkeleton', () => {
  it('mirrors the loaded list: the same three rows, in the same order', () => {
    render(<OnboardingChecklistSkeleton />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('announces the wait once rather than reading out every placeholder', () => {
    render(<OnboardingChecklistSkeleton />);

    expect(screen.getByRole('status')).toHaveTextContent(copy.loading);
  });
});
