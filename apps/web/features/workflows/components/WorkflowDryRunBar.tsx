'use client';

import { useCallback, useState } from 'react';
import type { WorkflowTestResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { TextInput } from '@/components/ui/TextInput';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { testWorkflowAction } from '../workflows.actions';
import styles from './WorkflowDryRunBar.module.css';

/**
 * Runs the saved workflow against one real ticket and lights the spine up.
 * Usage: `<WorkflowDryRunBar workflowId={id} isDirty={isDirty} onResult={…} />`.
 *
 * This is the canvas's payoff over the form dialog it replaced: the verdict does
 * not arrive as a list of sentences beside the definition, it arrives *on the
 * steps* — held, did not hold, would apply, nothing to change — because
 * `toGraph` keys every annotation on the same positional index the API's own
 * results use. The bar itself only fetches; the nodes do the reporting.
 *
 * **It checks what the server holds, not what is on screen.** `POST /workflows/
 * {id}/test` runs the *saved* definition, so an unsaved draft has nothing to
 * test and the control says so rather than reporting a verdict about a workflow
 * the supervisor has since changed. Same reason it is absent entirely on the
 * `/new` route: there is no id yet.
 *
 * It writes nothing — no run row, no ticket change, no notification.
 */
export function WorkflowDryRunBar({
  workflowId,
  isDirty,
  hasResult,
  onResult,
}: {
  /** `null` on the create route, where nothing is saved to test. */
  workflowId: string | null;
  isDirty: boolean;
  hasResult: boolean;
  onResult: (test: WorkflowTestResponse | null) => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const [ticketId, setTicketId] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  const perform = useCallback(async () => {
    // Unreachable: the submit control is absent without an id.
    if (workflowId === null) {
      throw new Error('Ran a dry run before the workflow was saved.');
    }

    return testWorkflowAction(workflowId, { ticketId: ticketId.trim() });
  }, [ticketId, workflowId]);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform,
    onSuccess: onResult,
  });

  const unavailable =
    workflowId === null ? copy.dryRunUnsavedNew : isDirty ? copy.dryRunUnsaved : null;

  return (
    <section className={styles.bar} aria-label={copy.dryRunHeading}>
      <h3 className={styles.heading}>{copy.dryRunHeading}</h3>
      <p className={styles.verdict}>{copy.testIntro}</p>

      {unavailable === null ? null : <Notice tone="info">{unavailable}</Notice>}

      <div className={styles.row}>
        <div className={styles.ticket}>
          <Field
            label={copy.testTicketLabel}
            hint={copy.testTicketHint}
            error={fieldError}
            isRequired
          >
            {({ controlId, describedBy, isInvalid }) => (
              <TextInput
                id={controlId}
                aria-describedby={describedBy}
                aria-invalid={isInvalid}
                name="dryRunTicketId"
                autoComplete="off"
                spellCheck={false}
                disabled={unavailable !== null}
                value={ticketId}
                onChange={(event) => {
                  setTicketId(event.target.value);
                  setFieldError(undefined);
                }}
              />
            )}
          </Field>
        </div>

        <Button
          variant="secondary"
          isPending={isPending}
          disabled={unavailable !== null}
          onClick={() => {
            if (ticketId.trim().length === 0) {
              setFieldError(copy.testTicketRequiredError);
              return;
            }

            setFieldError(undefined);
            // The verdict on the nodes belongs to the previous ticket; leaving it
            // there beside a new id would read as this ticket's answer.
            onResult(null);
            submit();
          }}
        >
          {copy.dryRunSubmit}
        </Button>

        {hasResult ? (
          <Button
            variant="ghost"
            onClick={() => {
              onResult(null);
            }}
          >
            {copy.dryRunClear}
          </Button>
        ) : null}
      </div>

      {formError === null ? null : <FormError message={formError} requestId={requestId} />}
    </section>
  );
}
