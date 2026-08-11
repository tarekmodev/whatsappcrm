'use client';

import type { UserResponse } from '@whatsappcrm/contracts';
import { CheckboxGroup } from '@/components/ui/CheckboxGroup';
import { useContent } from '@/lib/content';

/**
 * Picks which agents belong to a team. Usage:
 * `<AgentSelectionField users={users} selectedUserIds={ids} onChange={setIds} />`.
 *
 * The mirror image of `TeamSelectionField`, and shared by the create-team and
 * manage-members dialogs.
 */
export function AgentSelectionField({
  users,
  selectedUserIds,
  onChange,
}: {
  users: readonly UserResponse[];
  selectedUserIds: readonly string[];
  onChange: (userIds: readonly string[]) => void;
}) {
  const content = useContent();

  return (
    <CheckboxGroup
      legend={content.people.teamMembersLabel}
      hint={content.people.manageMembersDescription}
      emptyLabel={content.people.agentsEmptyBody}
      options={users.map((user) => ({
        value: user.id,
        label: user.displayName,
        hint: user.email,
      }))}
      selectedValues={selectedUserIds}
      onChange={onChange}
    />
  );
}
