'use client';

import { ASSIGNMENT_POLICY } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { CheckboxGroup } from '@/components/ui/CheckboxGroup';
import { Cluster } from '@/components/layout/Cluster';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { StaticFieldValue } from '@/components/ui/StaticFieldValue';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import type { AgentCapacityRow } from '../capacity';
import { resolveTicketLimit, type TicketLimitDraft } from '../capacity-input';

/**
 * One agent's limit, as read and as edited. Usage, inside the cap-edit dialog:
 * `<AgentCapacityFields row={row} workspaceDefault={5} draft={draft} onDraftChange={…} />`.
 *
 * Its own component because it has one reason to change — how a limit is shown
 * and typed — while the dialog around it owns the agent picker, the submit and
 * the toast. Controlled, so the dialog keeps a single draft it can send.
 *
 * The load line is read-only text rather than a disabled input: it is not a value
 * the supervisor may edit, and a disabled control both implies "not right now"
 * and is skipped by keyboard navigation, which would make the one number the
 * decision rests on unreadable to somebody tabbing through.
 */
/** The group's single option value. Never rendered; it only has to be stable. */
const USES_DEFAULT = 'workspace-default';

export function AgentCapacityFields({
  row,
  workspaceDefault,
  draft,
  error,
  isDisabled,
  onDraftChange,
}: {
  row: AgentCapacityRow;
  /** The cap an agent with no override of their own inherits. */
  workspaceDefault: number;
  draft: TicketLimitDraft;
  /** Set after a submit attempt, never while typing. */
  error?: string;
  isDisabled: boolean;
  onDraftChange: (draft: TicketLimitDraft) => void;
}) {
  const content = useContent();
  const resolved = resolveTicketLimit(draft);
  const isBelowLoad =
    resolved.status === 'valid' &&
    resolved.maxConcurrentTickets !== null &&
    resolved.maxConcurrentTickets < row.capacity.activeTicketCount;

  return (
    <>
      <Field
        label={content.assignment.capacityLoadLabel}
        hint={
          row.capacity.maxConcurrentTickets === null
            ? content.assignment.capacityInherited(workspaceDefault)
            : content.assignment.capacityOverridden
        }
      >
        {({ controlId }) => (
          <StaticFieldValue id={controlId}>
            <Cluster gap="2">
              <span>
                {content.assignment.capacityLoad(
                  row.capacity.activeTicketCount,
                  row.capacity.effectiveMaxConcurrentTickets,
                )}
              </span>
              {/* Colour is never the whole message: the badge says which of the
                  two states it is, in words. */}
              <Badge tone={row.isAtCapacity ? 'warning' : 'neutral'}>
                {row.isAtCapacity
                  ? content.assignment.capacityAtLimit
                  : content.assignment.capacityHasRoom}
              </Badge>
            </Cluster>
          </StaticFieldValue>
        )}
      </Field>

      {/* A group of one, rather than a `Field` wrapping a lone `Checkbox`: a
          checkbox's label belongs *beside* the box, and `Field` stacks it above,
          which reads as a heading with an orphaned box under it. Reusing the
          group is also what keeps the 44px target and the fieldset semantics
          instead of hand-assembling a label around a control. */}
      <CheckboxGroup
        legend={content.assignment.capacityLimitSourceLegend}
        name="usesDefault"
        options={[
          {
            value: USES_DEFAULT,
            label: content.assignment.capacityUseDefaultLabel(workspaceDefault),
          },
        ]}
        selectedValues={draft.usesDefault ? [USES_DEFAULT] : []}
        onChange={(values) => {
          onDraftChange({ ...draft, usesDefault: values.includes(USES_DEFAULT) });
        }}
      />

      {draft.usesDefault ? null : (
        <Field
          label={content.assignment.capacityLimitLabel}
          hint={content.assignment.capacityLimitHint(
            ASSIGNMENT_POLICY.minMaxConcurrentTickets,
            ASSIGNMENT_POLICY.maxMaxConcurrentTickets,
          )}
          error={error}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              name="maxConcurrentTickets"
              type="number"
              inputMode="numeric"
              min={ASSIGNMENT_POLICY.minMaxConcurrentTickets}
              max={ASSIGNMENT_POLICY.maxMaxConcurrentTickets}
              step={1}
              value={draft.limit}
              disabled={isDisabled}
              onChange={(event) => {
                onDraftChange({ ...draft, limit: event.target.value });
              }}
            />
          )}
        </Field>
      )}

      {/* ADR 0008's failure-mode table: a limit below what somebody already holds
          takes none of it away, which reads as a bug from the queue. Said before
          the button rather than discovered after it. */}
      {isBelowLoad ? (
        <Notice tone="warning">
          {content.assignment.capacityBelowLoadWarning(
            row.user.displayName,
            row.capacity.activeTicketCount,
          )}
        </Notice>
      ) : null}
    </>
  );
}
