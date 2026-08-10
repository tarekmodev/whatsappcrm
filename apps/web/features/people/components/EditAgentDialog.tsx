'use client';

import { useCallback, useState } from 'react';
import {
  TENANT_ROLES,
  USER_STATUSES,
  type TeamResponse,
  type TenantRole,
  type UserResponse,
  type UserStatus,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateAgentAction } from '../people.actions';
import { roleOptions, userStatusOptions } from '../presentation';
import { TeamSelectionField } from './TeamSelectionField';

/**
 * Changes an agent's name, role, teams or status. Usage:
 * `<EditAgentDialog user={user} teams={teams} onClose={…} />`.
 *
 * Sends only the fields that actually changed, because `UserUpdateInputSchema` is
 * a partial and a blanket write would clobber a concurrent edit to a field this
 * dialog never touched.
 */
export function EditAgentDialog({
  user,
  teams,
  onClose,
}: {
  user: UserResponse;
  teams: readonly TeamResponse[];
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<TenantRole>(user.role);
  const [status, setStatus] = useState<UserStatus>(user.status);
  const [teamIds, setTeamIds] = useState<readonly string[]>(user.teamIds);
  const [nameError, setNameError] = useState<string | null>(null);

  const perform = useCallback(async () => {
    return updateAgentAction(user.id, changedFields(user, { displayName, role, status, teamIds }));
  }, [displayName, role, status, teamIds, user]);

  const onSuccess = useCallback(
    ({ displayName: savedName }: { displayName: string }) => {
      showToast({ tone: 'success', message: content.people.editSuccess(savedName) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.people.editAgentTitle(user.displayName)}
      submitLabel={content.common.save}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        if (displayName.trim().length === 0) {
          setNameError(content.form.requiredFieldError);
          return;
        }

        setNameError(null);
        submit();
      }}
    >
      <Field label={content.people.editNameLabel} error={nameError ?? undefined} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="displayName"
            autoComplete="name"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setNameError(null);
            }}
          />
        )}
      </Field>

      <Field label={content.people.editRoleLabel} hint={content.roleDescriptions[role]}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            name="role"
            value={role}
            options={roleOptions(TENANT_ROLES)}
            onChange={(event) => {
              setRole(event.target.value as TenantRole);
            }}
          />
        )}
      </Field>

      <Field label={content.people.editStatusLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            name="status"
            value={status}
            options={userStatusOptions(USER_STATUSES)}
            onChange={(event) => {
              setStatus(event.target.value as UserStatus);
            }}
          />
        )}
      </Field>

      <TeamSelectionField
        teams={teams}
        selectedTeamIds={teamIds}
        onChange={setTeamIds}
        label={content.people.editTeamsLabel}
      />
    </FormDialog>
  );
}

interface EditableFields {
  displayName: string;
  role: TenantRole;
  status: UserStatus;
  teamIds: readonly string[];
}

/** Only what changed, so an untouched field is never written back. */
function changedFields(user: UserResponse, next: EditableFields): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const trimmedName = next.displayName.trim();

  if (trimmedName !== user.displayName) {
    patch.displayName = trimmedName;
  }

  if (next.role !== user.role) {
    patch.role = next.role;
  }

  if (next.status !== user.status) {
    patch.status = next.status;
  }

  if (!sameMembers(next.teamIds, user.teamIds)) {
    patch.teamIds = [...next.teamIds];
  }

  return patch;
}

/** Order is not meaningful for a membership list, so compare as sets. */
function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);

  return left.every((value) => rightSet.has(value));
}
