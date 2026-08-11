'use client';

import { useCallback, useState } from 'react';
import {
  USER_WRITABLE_STATUSES,
  type TeamResponse,
  type TenantRole,
  type UserResponse,
  type UserWritableStatus,
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
import { assignableRoles, canChangeRoleOf, type PeopleCaller } from '../role-assignment';
import { TeamSelectionField } from './TeamSelectionField';
import { StaticFieldValue } from '@/components/ui/StaticFieldValue';

/**
 * Changes an agent's name, role, teams or status. Usage:
 * `<EditAgentDialog user={user} teams={teams} caller={caller} onClose={…} />`.
 *
 * Sends only the fields that actually changed, because `UserUpdateInputSchema` is
 * a partial and a blanket write would clobber a concurrent edit to a field this
 * dialog never touched.
 *
 * **The role field is separate from the rest**, because the permissions are.
 * `user:update` covers name, status and teams; assigning a role additionally
 * requires `user:set_role`, and nobody may change their own role even as an admin.
 * The API *refuses* a body carrying `role` from a caller who may not set it rather
 * than dropping the field, so the control must be absent, not disabled — otherwise
 * a supervisor loses the rest of their edit to a 403. See `role-assignment.ts`.
 */
export function EditAgentDialog({
  user,
  teams,
  caller,
  onClose,
}: {
  user: UserResponse;
  teams: readonly TeamResponse[];
  caller: PeopleCaller;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<TenantRole>(user.role);
  const [status, setStatus] = useState<UserWritableStatus>(writableStatusOf(user));
  const [teamIds, setTeamIds] = useState<readonly string[]>(user.teamIds);
  const [nameError, setNameError] = useState<string | null>(null);
  const mayChangeRole = canChangeRoleOf(caller, user.id);

  const perform = useCallback(async () => {
    return updateAgentAction(
      user.id,
      changedFields(user, { displayName, role, status, teamIds }, mayChangeRole),
    );
  }, [mayChangeRole, displayName, role, status, teamIds, user]);

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

      {mayChangeRole ? (
        <Field label={content.people.editRoleLabel} hint={content.roleDescriptions[role]}>
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              name="role"
              value={role}
              options={roleOptions(assignableRoles(caller))}
              onChange={(event) => {
                setRole(event.target.value as TenantRole);
              }}
            />
          )}
        </Field>
      ) : (
        // Not a disabled control: a caller without `user:set_role` has no business
        // seeing a role picker, but they do need to know what the person is.
        <Field label={content.people.editRoleLabel} hint={content.people.roleNotEditableHint}>
          {({ controlId }) => (
            <StaticFieldValue id={controlId}>{content.roles[user.role]}</StaticFieldValue>
          )}
        </Field>
      )}

      <Field label={content.people.editStatusLabel} hint={content.people.statusHint}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            name="status"
            value={status}
            options={userStatusOptions(USER_WRITABLE_STATUSES)}
            onChange={(event) => {
              setStatus(event.target.value as UserWritableStatus);
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

/**
 * A `removed` or `invited` account cannot be the *initial* value of a picker whose
 * options are `active`/`suspended` — the browser would silently show the first
 * option and a save would flip a status the user never touched. `invited` maps to
 * `active` because that is what accepting does; `removed` is unreachable here,
 * since the list excludes soft-deleted accounts.
 */
function writableStatusOf(user: UserResponse): UserWritableStatus {
  return user.status === 'suspended' ? 'suspended' : 'active';
}

interface EditableFields {
  displayName: string;
  role: TenantRole;
  status: UserWritableStatus;
  teamIds: readonly string[];
}

/**
 * Only what changed, so an untouched field is never written back — and `role` only
 * when the caller may set it. Sending it otherwise costs the whole request: the API
 * refuses a body carrying `role` without `user:set_role` rather than ignoring it.
 */
function changedFields(
  user: UserResponse,
  next: EditableFields,
  mayChangeRole: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const trimmedName = next.displayName.trim();

  if (trimmedName !== user.displayName) {
    patch.displayName = trimmedName;
  }

  if (mayChangeRole && next.role !== user.role) {
    patch.role = next.role;
  }

  if (next.status !== writableStatusOf(user)) {
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
