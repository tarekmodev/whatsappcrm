'use client';

import { useCallback, useState } from 'react';
import type { WorkflowResponse, WorkflowTestResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { TextInput } from '@/components/ui/TextInput';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { testWorkflowAction } from '../workflows.actions';
import { WorkflowTestResult, WorkflowTestResultSkeleton } from './WorkflowTestResult';

/**
 * The dry run: checks a workflow against one real ticket and reports what would
 * happen. Usage: `<TestWorkflowDialog workflow={workflow} vocabulary={…} onClose={…} />`.
 *
 * **It writes nothing** — no run row, no ticket change, no notification — which
 * is why it is a separate surface rather than a "run it once" button. A
 * supervisor testing a workflow that closes tickets should not close one, and
 * there is no way to un-close it.
 *
 * The result replaces nothing: the ticket field stays, so the same workflow can
 * be checked against a second ticket without reopening the dialog.
 *
 * It takes no vocabulary, unlike the other dialogs: every name in the answer is
 * already resolved by the API into `describes`, so resolving ids here would be a
 * second, staler copy of the same lookup.
 */
export function TestWorkflowDialog({
  workflow,
  onClose,
}: {
  workflow: WorkflowResponse;
  onClose: () => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const [ticketId, setTicketId] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<WorkflowTestResponse | null>(null);

  const perform = useCallback(async () => {
    return testWorkflowAction(workflow.id, { ticketId: ticketId.trim() });
  }, [ticketId, workflow.id]);

  const onSuccess = useCallback((data: WorkflowTestResponse) => {
    setResult(data);
  }, []);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={copy.testTitle(workflow.name)}
      description={copy.testIntro}
      submitLabel={copy.testSubmit}
      isPending={isPending}
      formError={fieldError === undefined ? formError : null}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        if (ticketId.trim().length === 0) {
          setFieldError(copy.testTicketRequiredError);
          return;
        }

        setFieldError(undefined);
        // The previous verdict belongs to the previous ticket; leaving it on
        // screen beside a new id would read as this ticket's answer.
        setResult(null);
        submit();
      }}
    >
      <Field label={copy.testTicketLabel} hint={copy.testTicketHint} error={fieldError} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="ticketId"
            autoComplete="off"
            spellCheck={false}
            value={ticketId}
            onChange={(event) => {
              setTicketId(event.target.value);
              setFieldError(undefined);
            }}
          />
        )}
      </Field>

      {isPending ? <WorkflowTestResultSkeleton workflow={workflow} /> : null}
      {!isPending && result !== null ? <WorkflowTestResult result={result} /> : null}
    </FormDialog>
  );
}
