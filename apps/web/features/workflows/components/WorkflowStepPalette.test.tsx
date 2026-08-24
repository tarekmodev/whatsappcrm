import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { workflowCatalog, type WorkflowCatalogResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { EMPTY_WORKFLOW_VOCABULARY, type WorkflowVocabulary } from '../presentation';
import { WorkflowStepPalette } from './WorkflowStepPalette';

/**
 * The palette's whole job is to never offer a step the server would refuse. Two
 * ways that goes wrong: offering a tag condition in a workspace with no tags,
 * and offering an eleventh condition — and the second has to be read from the
 * *catalog's* cap rather than from the constants this bundle happens to carry,
 * or a console a version behind disagrees with the API it is talking to.
 */

const copy = content.workflows;
const CATALOG = workflowCatalog();

function renderPalette(
  overrides: Partial<Parameters<typeof WorkflowStepPalette>[0]> = {},
  vocabulary: WorkflowVocabulary = EMPTY_WORKFLOW_VOCABULARY,
  catalog: WorkflowCatalogResponse = CATALOG,
) {
  const onAddCondition = vi.fn();
  const onAddAction = vi.fn();

  render(
    <WorkflowStepPalette
      catalog={catalog}
      vocabulary={vocabulary}
      conditionCount={0}
      actionCount={0}
      onAddCondition={onAddCondition}
      onAddAction={onAddAction}
      {...overrides}
    />,
  );

  return { onAddCondition, onAddAction };
}

describe('WorkflowStepPalette', () => {
  it('adds the type that was picked, not whatever happened to be first', () => {
    const { onAddCondition } = renderPalette();

    fireEvent.change(fieldByLabel(copy.addConditionTypeLabel), {
      target: { value: 'ticket_age' },
    });
    fireEvent.click(screen.getByRole('button', { name: copy.addCondition }));

    expect(onAddCondition).toHaveBeenCalledWith('ticket_age');
  });

  it('never offers a tag condition in a workspace that has no tags to match on', () => {
    renderPalette();

    const picker = fieldByLabel(copy.addConditionTypeLabel);
    const offered = [...picker.querySelectorAll('option')].map((option) => option.value);

    expect(offered).not.toContain('ticket_tag');
    expect(offered).not.toContain('contact_tag');
  });

  it('stands the add control down at the catalog’s cap, and says why', () => {
    renderPalette({ conditionCount: CATALOG.limits.conditionsPerWorkflow });

    expect(screen.getByRole('button', { name: copy.addCondition })).toBeDisabled();
    expect(
      screen.getByText(copy.conditionsFullHint(CATALOG.limits.conditionsPerWorkflow)),
    ).toBeInTheDocument();
  });

  /**
   * The cap comes from the catalog the *server* published, so a console running
   * behind an API that raised the limit offers the extra step rather than
   * refusing it on a stale constant.
   */
  it('reads its caps from the catalog rather than from the bundled constants', () => {
    const raised: WorkflowCatalogResponse = {
      ...CATALOG,
      limits: { ...CATALOG.limits, actionsPerWorkflow: CATALOG.limits.actionsPerWorkflow + 2 },
    };

    renderPalette({ actionCount: CATALOG.limits.actionsPerWorkflow }, undefined, raised);

    expect(screen.getByRole('button', { name: copy.addAction })).toBeEnabled();
  });
});
