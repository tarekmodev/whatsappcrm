'use client';

import { useCallback, useState } from 'react';
import { ASSIGNMENT_POLICY } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
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
 * reversible thing than the one this story asks for.
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
          ? content.assignment.capacityClearedSuccess(name, workspaceDefault)
          : content.assignment.capacitySuccess(name, nextLimit),
    });
    onClose();
  }, [content, nextLimit, onClose, selected, showToast, workspaceDefault]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.assignment.capacityTitle}
      description={content.assignment.capacityDescription}
      submitLabel={content.assignment.capacitySubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        // Checked here as well as by the API: a value out of range is a 400
        // either way, and catching it before the round trip beats being told.
        if (resolved.status === 'invalid') {
          setLimitError(
            content.assignment.capacityRangeError(
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
      <Field
        label={content.assignment.capacityAgentLabel}
        hint={
          hasMore
            ? content.assignment.capacityAgentHintTruncated
            : content.assignment.capacityAgentHint
        }
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
              label: content.assignment.capacityAgentOption(
                row.user.displayName,
                row.capacity.activeTicketCount,
                row.capacity.effectiveMaxConcurrentTickets,
              ),
            }))}
            onChange={(event) => {
              const nextRow = findCapacityRow(rows, event.target.value);

              setUserId(event.target.value);
              setLimitError(undefined);

              // The form re-reads from the agent it now describes. Carrying the
              // previous agent's number across would let a supervisor save a
              // value they last saw beside somebody else's name.
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
          error={limitError}
          isDisabled={isPending}
          onDraftChange={(next) => {
            setDraft(next);
            setLimitError(undefined);
          }}
        />
      )}
    </FormDialog>
  );
}
