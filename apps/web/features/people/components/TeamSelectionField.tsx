'use client';

import type { TeamResponse } from '@whatsappcrm/contracts';
import { CheckboxGroup } from '@/components/ui/CheckboxGroup';
import { useContent } from '@/lib/content';

/**
 * Team membership picker. Usage:
 * `<TeamSelectionField teams={teams} selectedTeamIds={ids} onChange={setIds} />`.
 *
 * Extracted because the invite dialog, the edit dialog and the create-team dialog
 * all need it — the second occurrence, not the third.
 */
export function TeamSelectionField({
  teams,
  selectedTeamIds,
  onChange,
  label,
}: {
  teams: readonly TeamResponse[];
  selectedTeamIds: readonly string[];
  onChange: (teamIds: readonly string[]) => void;
  label?: string;
}) {
  const content = useContent();

  return (
    <CheckboxGroup
      legend={label ?? content.people.inviteTeamsLabel}
      hint={content.people.inviteTeamsHint}
      emptyLabel={content.people.teamsEmptyBody}
      options={teams.map((team) => ({
        value: team.id,
        label: team.name,
        hint: team.description ?? undefined,
      }))}
      selectedValues={selectedTeamIds}
      onChange={onChange}
    />
  );
}
