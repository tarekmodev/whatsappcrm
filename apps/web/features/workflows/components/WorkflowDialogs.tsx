'use client';

import type { WorkflowCatalogResponse, WorkflowResponse } from '@whatsappcrm/contracts';
import type { WorkflowVocabulary } from '../presentation';
import {
  LazyDeleteWorkflowDialog,
  LazyTestWorkflowDialog,
  LazyWorkflowFormDialog,
  LazyWorkflowRunsDialog,
} from './workflow-dialogs.lazy';

/**
 * Which dialog the workflow list has open, if any.
 *
 * A discriminated union rather than four independent `useState`s: only one
 * dialog can be open at a time, and four booleans can represent three states
 * that are not reachable — which is how a modal ends up rendered behind another.
 */
export type OpenWorkflowDialog =
  | { readonly kind: 'edit'; readonly workflow: WorkflowResponse }
  | { readonly kind: 'delete'; readonly workflow: WorkflowResponse }
  | { readonly kind: 'test'; readonly workflow: WorkflowResponse }
  | { readonly kind: 'runs'; readonly workflow: WorkflowResponse }
  | null;

/**
 * Renders whichever dialog is open. Usage:
 * `<WorkflowDialogs dialog={dialog} catalog={catalog} vocabulary={vocabulary} onClose={…} />`.
 *
 * Each one is behind its own lazy boundary, so a supervisor who only wanted to
 * read the list downloads none of them — and opening the run history does not
 * pull in the builder.
 */
export function WorkflowDialogs({
  dialog,
  catalog,
  vocabulary,
  onClose,
}: {
  dialog: OpenWorkflowDialog;
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  onClose: () => void;
}) {
  if (dialog === null) {
    return null;
  }

  switch (dialog.kind) {
    case 'edit':
      return (
        <LazyWorkflowFormDialog
          workflow={dialog.workflow}
          catalog={catalog}
          vocabulary={vocabulary}
          onClose={onClose}
        />
      );

    case 'delete':
      return <LazyDeleteWorkflowDialog workflow={dialog.workflow} onClose={onClose} />;

    case 'test':
      return <LazyTestWorkflowDialog workflow={dialog.workflow} onClose={onClose} />;

    case 'runs':
      return <LazyWorkflowRunsDialog workflow={dialog.workflow} onClose={onClose} />;
  }
}
