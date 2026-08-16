'use client';

import type { WorkflowAssignmentState, WorkflowCondition } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import {
  ASSIGNMENT_STATES,
  labelledOptions,
  teamOptions,
  userOptions,
  withAssignmentState,
  withPlaceholder,
} from '../builder';
import type { WorkflowVocabulary } from '../presentation';

type AssignmentCondition = Extract<WorkflowCondition, { type: 'ticket_assignment' }>;

/**
 * "It is assigned to the Billing team." Usage: rendered by `ConditionFields` for
 * a `ticket_assignment` condition.
 *
 * The second control appears only where the state takes one, and switching state
 * clears whichever id the previous state carried — the contract refines on
 * exactly that, so normalising here is what stops a well-formed-looking draft
 * being refused for a field the form is no longer showing.
 *
 * The placeholder is "Any team" / "Anyone" rather than a blank: leaving it
 * unchosen is a real answer here — "assigned to somebody, no matter who" — and
 * an empty option that looked like a mistake would hide that.
 */
export function AssignmentConditionFields({
  condition,
  vocabulary,
  onChange,
}: {
  condition: AssignmentCondition;
  vocabulary: WorkflowVocabulary;
  onChange: (condition: WorkflowCondition) => void;
}) {
  const content = useContent();
  const copy = content.workflows;

  return (
    <>
      <Field label={copy.assignmentStateLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={condition.state}
            options={labelledOptions(ASSIGNMENT_STATES, copy.assignmentStates)}
            onChange={(event) => {
              onChange(
                withAssignmentState(condition, event.target.value as WorkflowAssignmentState),
              );
            }}
          />
        )}
      </Field>

      {condition.state === 'assigned_to_team' ? (
        <Field label={copy.assignmentTeamLabel}>
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              value={condition.teamId ?? ''}
              options={withPlaceholder(teamOptions(vocabulary), copy.anyTeam)}
              onChange={(event) => {
                onChange({ ...condition, teamId: emptyToNull(event.target.value) });
              }}
            />
          )}
        </Field>
      ) : null}

      {condition.state === 'assigned_to_user' ? (
        <Field label={copy.assignmentUserLabel}>
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              value={condition.userId ?? ''}
              options={withPlaceholder(userOptions(vocabulary, condition.userId), copy.anyUser)}
              onChange={(event) => {
                onChange({ ...condition, userId: emptyToNull(event.target.value) });
              }}
            />
          )}
        </Field>
      ) : null}
    </>
  );
}

/** A `<select>` has no null; the placeholder's empty value is what stands for it. */
function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}
