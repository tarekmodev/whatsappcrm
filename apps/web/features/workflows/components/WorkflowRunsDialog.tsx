'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowResponse, WorkflowRunResponse } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { Modal } from '@/components/ui/Modal';
import { useContent } from '@/lib/content';
import { listWorkflowRunsAction } from '../workflows.actions';
import { WorkflowRunList, WorkflowRunListSkeleton } from './WorkflowRunList';

/**
 * "Did this workflow run, and what did it do?" Usage:
 * `<WorkflowRunsDialog workflow={workflow} onClose={…} />`.
 *
 * ADR 0009 makes this the *first* thing to read when a workflow looks wrong,
 * ahead of its definition — it says whether the workflow ran, whether its
 * conditions matched and what each action did.
 *
 * The read happens on open rather than with the page: the run list is per
 * workflow and grows with ticket volume, so loading every workflow's history up
 * front would be a page-load cost paid for a panel most visits never open.
 */
export function WorkflowRunsDialog({
  workflow,
  onClose,
}: {
  workflow: WorkflowResponse;
  onClose: () => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const [state, setState] = useState<RunsState>({ status: 'loading' });
  /**
   * False once the dialog has unmounted, so a response that arrives afterwards
   * — or after a retry superseded it — is dropped rather than setting state on
   * a component that is gone.
   */
  const isMountedRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });

    const result = await listWorkflowRunsAction(workflow.id);

    if (!isMountedRef.current) {
      return;
    }

    setState(
      result.status === 'success'
        ? { status: 'loaded', runs: result.data }
        : { status: 'failed', message: result.message },
    );
  }, [workflow.id]);

  useEffect(() => {
    isMountedRef.current = true;
    void load();

    return () => {
      isMountedRef.current = false;
    };
  }, [load]);

  return (
    <Modal
      isOpen
      title={copy.runsTitle(workflow.name)}
      description={copy.runsIntro}
      onClose={onClose}
      footer={
        <Button variant="secondary" isBlock onClick={onClose}>
          {content.common.close}
        </Button>
      }
    >
      <Stack gap="3">
        {state.status === 'loading' ? <WorkflowRunListSkeleton /> : null}
        {state.status === 'failed' ? (
          <ErrorState
            description={state.message}
            onRetry={() => {
              void load();
            }}
          />
        ) : null}
        {state.status === 'loaded' ? <WorkflowRunList runs={state.runs} /> : null}
      </Stack>
    </Modal>
  );
}

/**
 * Loading, loaded or failed — one value rather than three booleans, so "failed
 * while showing stale runs" is not a state this component can reach.
 */
type RunsState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly runs: readonly WorkflowRunResponse[] }
  | { readonly status: 'failed'; readonly message: string };
