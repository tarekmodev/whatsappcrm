'use client';

import { useCallback, useState } from 'react';
import { ASSIGNMENT_POLICY } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent, type Content } from '@/lib/content';
import { updateAgentCapacityAction } from '../assignment.actions';
import { findCapacityRow, type AgentCapacityRow } from '../capacity';
import { draftForRow, resolveTicketLimit, type TicketLimitDraft } from '../capacity-input';
import { AgentCapacityFields } from './AgentCapacityFields';

/**
 * Changes one agent's concurrent-ticket limit, from the queue where that limit is
 * causing trouble. Usage:
 * `<AgentCapacityDialog rows={rows} workspaceDefault={5} hasMore={false} onClose={…} />`.
 *
 * **One agent at a time**, per TAR-384: bulk and team-level editing are out of
 * scope, and a control that changed everybody's limit at once would be a far less
 * reversible thing than the one this story asks for. That scope is said to the
 * supervisor in the picker's hint rather than only in the issue.
 *
 * The picker opens on whoever is most in the way — `toAgentCapacityRows` sorts
 * agents at their limit first — so the common case is open, read, save.
 *
 * No confirmation step in front of the write: it is reversible by this same
 * control, and the one genuinely surprising consequence (a lower limit takes no
 * ticket off anybody) is said in front of the button rather than behind a second
 * dialog.
 */
export function AgentCapacityDialog({
  rows,
  workspaceDefault,
  hasMore,
  onClose,
}: {
  /** Rotation candidates with a published capacity. Never empty — see `loadAgentCapacity`. */
  rows: readonly AgentCapacityRow[];
  /** The cap an agent with no override of their own inherits. */
  workspaceDefault: number;
  /** True when the workspace has more agents than this page holds. */
  hasMore: boolean;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const first = rows[0] ?? null;
  const [userId, setUserId] = useState(first?.user.id ?? '');
  const [draft, setDraft] = useState<TicketLimitDraft>(() =>
    first === null ? { usesDefault: true, limit: '' } : draftForRow(first),
  );
  const [limitError, setLimitError] = useState<string | undefined>(undefined);
  const selected = findCapacityRow(rows, userId);
  const resolved = resolveTicketLimit(draft);
  const nextLimit = resolved.status === 'valid' ? resolved.maxConcurrentTickets : null;

  const perform = useCallback(
    async () => updateAgentCapacityAction(userId, { maxConcurrentTickets: nextLimit }),
    [nextLimit, userId],
  );

  const onSuccess = useCallback(() => {
    const name = selected?.user.displayName ?? content.common.unassigned;

    showToast({
      tone: 'success',
      // Names the agent and the number: the dialog closes over the row, so this
      // is the only remaining record of what changed.
      message:
        nextLimit === null
          ? content.assignment.raiseLimitClearedSuccess(name, workspaceDefault)
          : content.assignment.raiseLimitSuccess(name, nextLimit),
    });
    onClose();
  }, [content, nextLimit, onClose, selected, showToast, workspaceDefault]);

  const { submit, isPending, formError, requestId, errorCode, clearError } = useActionForm({
    perform,
    onSuccess,
  });

  /*
   * A refusal the supervisor cannot answer from in here, or nothing.
   *
   * These two replace the API's own message rather than sitting beside it: the
   * server says *what* it refused, and on both of these the only useful next
   * step is to leave and come back — a message that does not say so leaves
   * somebody pressing a button that will refuse again. Every other code keeps
   * the action's message, because every other code is worth a retry.
   */
  const blockingFailure = terminalFailure(errorCode, content);
  /*
   * A server-side range refusal belongs in the field, beside the value that
   * caused it, not in a banner above a form the reader then has to search.
   *
   * Matched on the code alone rather than on `details[].path`, which
   * `ActionResult` does not carry: the only value this dialog lets anybody type
   * is `maxConcurrentTickets` — the agent comes from a `Select` of ids the
   * server just sent — so a `validation_failed` here has exactly one field it
   * can be about.
   */
  const serverFieldError = errorCode === 'validation_failed' ? formError : null;
  // Never empty in practice: `loadAgentCapacity` returns `null` rather than a
  // report with no agents, so the notice is a rendered state, not a crash.
  const hasNoAgents = rows.length === 0;

  return (
    <FormDialog
      isOpen
      title={content.assignment.raiseLimitTitle}
      description={content.assignment.raiseLimitDescription}
      submitLabel={content.assignment.raiseLimitSubmit}
      isPending={isPending}
      formError={blockingFailure ?? (serverFieldError === null ? formError : null)}
      requestId={requestId}
      isSubmitDisabled={blockingFailure !== null || hasNoAgents}
      onClose={onClose}
      onSubmit={() => {
        // Checked here as well as by the API: a value out of range is a 400
        // either way, and catching it before the round trip beats being told.
        if (resolved.status === 'invalid') {
          setLimitError(
            content.assignment.raiseLimitValueError(
              ASSIGNMENT_POLICY.minMaxConcurrentTickets,
              ASSIGNMENT_POLICY.maxMaxConcurrentTickets,
            ),
          );
          return;
        }

        setLimitError(undefined);
        submit();
      }}
    >
      {hasNoAgents ? (
        <Notice tone="warning">{content.assignment.raiseLimitNoAgentsError}</Notice>
      ) : (
        <>
          <Field
            label={content.assignment.raiseLimitAgentLabel}
            hint={content.assignment.raiseLimitAgentHint(hasMore)}
            isRequired
          >
            {({ controlId, describedBy }) => (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                name="userId"
                value={userId}
                disabled={isPending}
                options={rows.map((row) => ({
                  value: row.user.id,
                  label: content.assignment.raiseLimitAgentOption(
                    row.user.displayName,
                    row.capacity.activeTicketCount,
                    row.capacity.effectiveMaxConcurrentTickets,
                  ),
                }))}
                onChange={(event) => {
                  const nextRow = findCapacityRow(rows, event.target.value);

                  setUserId(event.target.value);
                  setLimitError(undefined);
                  /*
                   * The server's refusal was about the agent who just left the
                   * form. `useActionForm` only clears on the next submit, and a
                   * `forbidden` or `not_found` disables the button — so without
                   * this the dialog insists an agent is gone after the
                   * supervisor has already picked somebody else, with no way
                   * back but a reload.
                   */
                  clearError();

                  // The form re-reads from the agent it now describes. Carrying
                  // the previous agent's number across would let a supervisor
                  // save a value they last saw beside somebody else's name.
                  if (nextRow !== null) {
                    setDraft(draftForRow(nextRow));
                  }
                }}
              />
            )}
          </Field>

          {selected === null ? null : (
            <AgentCapacityFields
              row={selected}
              workspaceDefault={workspaceDefault}
              draft={draft}
              error={limitError ?? serverFieldError ?? undefined}
              isDisabled={isPending}
              onDraftChange={(next) => {
                setDraft(next);
                setLimitError(undefined);
                // Same reason the client-side error goes: the server refused a
                // value that is no longer in the field. Leaving it would keep
                // `aria-invalid` and a stale message on a number nobody typed.
                clearError();
              }}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}

/**
 * Copy for a refusal that closing and reloading is the only answer to, or `null`
 * for everything the supervisor can usefully retry from where they are.
 *
 * Branching on the code rather than the message, which is server-owned copy: a
 * reword or a translation must not be able to turn a blocking failure into a
 * retryable one. An unknown code is retryable by default — never a hard fail on
 * something the contract may add later.
 */
function terminalFailure(errorCode: string | null, content: Content): string | null {
  switch (errorCode) {
    case 'forbidden':
      return content.assignment.raiseLimitForbidden;
    case 'not_found':
      return content.assignment.raiseLimitNotFound;
    default:
      return null;
  }
}
