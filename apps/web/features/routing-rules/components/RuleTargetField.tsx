'use client';

import { useState } from 'react';
import type { RoutingTarget, TeamResponse, UserResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select, type SelectOption } from '@/components/ui/Select';
import { useContent } from '@/lib/content';

/**
 * Where a matching conversation goes: a team, or one named agent. Usage:
 * `<RuleTargetField target={target} teams={teams} users={users} onChange={…} />`.
 *
 * Two selects rather than one flat list of teams-and-people, because the contract
 * models the target as a discriminated union and a flat list would need both
 * kinds encoded into one value string — the sort of thing that works until a team
 * and an agent share an id shape.
 *
 * Only agents who can actually take the work are offered. A suspended agent is
 * skipped by the routing engine at evaluation time, so a rule pointing at one is
 * a rule that silently never fires; the exception is the agent this rule already
 * targets, which stays listed so the current value is visible rather than blank.
 */
export function RuleTargetField({
  target,
  teams,
  users,
  error,
  onChange,
}: {
  target: RoutingTarget | null;
  teams: readonly TeamResponse[];
  users: readonly UserResponse[];
  error?: string;
  onChange: (target: RoutingTarget | null) => void;
}) {
  const content = useContent();
  const copy = content.routingRules;
  // Which of the two pickers is showing. Local state rather than derived from
  // `target`, because clearing the target must not snap the form back to teams.
  const [kind, setKind] = useState<RoutingTarget['kind']>(target?.kind ?? 'team');
  const currentUserId = target?.kind === 'user' ? target.userId : null;

  const teamOptions: readonly SelectOption[] = teams.map((team) => ({
    value: team.id,
    label: team.name,
  }));
  const userOptions: readonly SelectOption[] = users
    .filter((user) => user.status === 'active' || user.id === currentUserId)
    .map((user) => ({ value: user.id, label: user.displayName }));

  return (
    <>
      <Field label={copy.targetKindLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={kind}
            options={[
              { value: 'team', label: copy.targetKindTeam },
              { value: 'user', label: copy.targetKindUser },
            ]}
            onChange={(event) => {
              // Switching kind clears the target rather than pre-picking one:
              // "route to a team" is not an answer to "which team".
              setKind(event.target.value === 'user' ? 'user' : 'team');
              onChange(null);
            }}
          />
        )}
      </Field>

      {kind === 'team' ? (
        <Field
          label={copy.targetTeamLabel}
          error={error}
          hint={teamOptions.length === 0 ? copy.noTeamsHint : undefined}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              value={target?.kind === 'team' ? target.teamId : ''}
              options={withPlaceholder(teamOptions, copy.targetRequiredError)}
              onChange={(event) => {
                onChange(
                  event.target.value === '' ? null : { kind: 'team', teamId: event.target.value },
                );
              }}
            />
          )}
        </Field>
      ) : (
        <Field label={copy.targetUserLabel} error={error} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              value={currentUserId ?? ''}
              options={withPlaceholder(userOptions, copy.targetRequiredError)}
              onChange={(event) => {
                onChange(
                  event.target.value === '' ? null : { kind: 'user', userId: event.target.value },
                );
              }}
            />
          )}
        </Field>
      )}
    </>
  );
}

/**
 * A native select always has a value, so an unchosen target needs an explicit
 * empty option — otherwise the first team appears "selected" without anyone
 * choosing it, and a rule gets a target its author never picked.
 */
function withPlaceholder(
  options: readonly SelectOption[],
  placeholder: string,
): readonly SelectOption[] {
  return [{ value: '', label: placeholder }, ...options];
}
