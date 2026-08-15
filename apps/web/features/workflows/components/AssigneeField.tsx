'use client';

import { useState } from 'react';
import type { WorkflowAssignee } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { teamOptions, userOptions, withPlaceholder } from '../builder';
import type { WorkflowVocabulary } from '../presentation';

/**
 * Who a ticket is reassigned to: a team, or one named agent. Usage:
 * `<AssigneeField target={action.target} vocabulary={vocabulary} onChange={…} />`.
 *
 * Two selects rather than one flat list of teams-and-people, because the
 * contract models the assignee as a discriminated union and a flat list would
 * need both kinds encoded into one value string — the sort of thing that works
 * until a team and an agent share an id shape.
 *
 * Only agents who can actually take the work are offered; the exception is the
 * agent the action already names, kept listed so the current value is visible
 * rather than blank.
 */
export function AssigneeField({
  target,
  vocabulary,
  error,
  onChange,
}: {
  target: WorkflowAssignee;
  vocabulary: WorkflowVocabulary;
  error?: string;
  onChange: (target: WorkflowAssignee) => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  // Which of the two pickers is showing. Local state as well as the union's own
  // `kind`, so clearing the id does not snap the form back to teams.
  const [kind, setKind] = useState<WorkflowAssignee['kind']>(target.kind);
  const currentUserId = target.kind === 'user' ? target.userId : null;

  return (
    <>
      <Field label={copy.assigneeKindLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={kind}
            options={[
              { value: 'team', label: copy.assigneeKindTeam },
              { value: 'user', label: copy.assigneeKindUser },
            ]}
            onChange={(event) => {
              // Switching kind clears the id rather than pre-picking one:
              // "reassign to a team" is not an answer to "which team".
              const next = event.target.value === 'user' ? 'user' : 'team';

              setKind(next);
              onChange(
                next === 'user' ? { kind: 'user', userId: '' } : { kind: 'team', teamId: '' },
              );
            }}
          />
        )}
      </Field>

      {kind === 'team' ? (
        <Field
          label={copy.assigneeTeamLabel}
          error={error}
          hint={vocabulary.teams.length === 0 ? copy.noTeamsHint : undefined}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              value={target.kind === 'team' ? target.teamId : ''}
              options={withPlaceholder(teamOptions(vocabulary), copy.assigneeRequiredError)}
              onChange={(event) => {
                onChange({ kind: 'team', teamId: event.target.value });
              }}
            />
          )}
        </Field>
      ) : (
        <Field label={copy.assigneeUserLabel} error={error} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              value={currentUserId ?? ''}
              options={withPlaceholder(
                userOptions(vocabulary, currentUserId),
                copy.assigneeRequiredError,
              )}
              onChange={(event) => {
                onChange({ kind: 'user', userId: event.target.value });
              }}
            />
          )}
        </Field>
      )}
    </>
  );
}
