'use client';

import { useCallback, useState } from 'react';
import type { TeamResponse, UserResponse } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateTeamMembersAction } from '../people.actions';
import { AgentSelectionField } from './AgentSelectionField';

/**
 * Adds and removes team members after the team exists. Usage:
 * `<TeamMembersDialog team={team} users={users} onClose={…} />`.
 *
 * This is the "add agents to a team" half of TAR-22's second acceptance criterion.
 * It writes through `PATCH /v1/teams/{id}` — see `lib/api/teams.ts` for why that
 * route, and the note raised with TAR-81.
 */
export function TeamMembersDialog({
  team,
  users,
  onClose,
}: {
  team: TeamResponse;
  users: readonly UserResponse[];
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [memberUserIds, setMemberUserIds] = useState<readonly string[]>(team.memberUserIds);

  const perform = useCallback(async () => {
    return updateTeamMembersAction(team.id, { memberUserIds: [...memberUserIds] });
  }, [memberUserIds, team.id]);

  const onSuccess = useCallback(
    ({ name }: { name: string }) => {
      showToast({ tone: 'success', message: content.people.manageMembersSuccess(name) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.people.manageMembersTitle(team.name)}
      description={content.people.manageMembersDescription}
      submitLabel={content.common.save}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={submit}
    >
      <AgentSelectionField
        users={users}
        selectedUserIds={memberUserIds}
        onChange={setMemberUserIds}
      />
    </FormDialog>
  );
}
