'use client';

import { useCallback, useState } from 'react';
import {
  InviteCreateInputSchema,
  type TeamResponse,
  type TenantRole,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { inviteAgentAction } from '../people.actions';
import { roleOptions } from '../presentation';
import { invitableRoles, type PeopleCaller } from '../role-assignment';
import { StaticFieldValue } from '@/components/ui/StaticFieldValue';
import { TeamSelectionField } from './TeamSelectionField';

/**
 * Creates an agent with a role and team memberships. Usage:
 * `<InviteAgentDialog teams={teams} caller={caller} onClose={…} />` — mounted only
 * while open, so its chunk loads on first use.
 *
 * Validation runs against the contract's `InviteCreateInputSchema`, the identical
 * object the API validates with, so the user is not sent on a round trip to learn
 * that an email is malformed.
 *
 * The role picker is capped by `invitableRoles`: a caller without `user:set_role`
 * may invite an `agent` and nothing else, because `InviteCreateInputSchema.role`
 * accepts any role and without the cap a supervisor could mint an admin (TAR-79,
 * delta 1). The API refuses it either way; this stops the console offering it.
 */
export function InviteAgentDialog({
  teams,
  caller,
  onClose,
}: {
  teams: readonly TeamResponse[];
  caller: PeopleCaller;
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TenantRole>('agent');
  const [teamIds, setTeamIds] = useState<readonly string[]>([]);
  const [emailError, setEmailError] = useState<string | null>(null);
  const roles = invitableRoles(caller);

  const perform = useCallback(async () => {
    return inviteAgentAction({ email: email.trim(), role, teamIds: [...teamIds] });
  }, [email, role, teamIds]);

  const onSuccess = useCallback(
    ({ email: invitedEmail }: { email: string }) => {
      showToast({ tone: 'success', message: content.people.inviteSuccess(invitedEmail) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.people.inviteAgentTitle}
      description={content.people.inviteAgentDescription}
      submitLabel={content.people.inviteSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        const parsed = InviteCreateInputSchema.safeParse({
          email: email.trim(),
          role,
          teamIds: [...teamIds],
        });

        if (!parsed.success) {
          // The only field a user can get wrong here is the email address.
          setEmailError(
            email.trim().length === 0
              ? content.form.requiredFieldError
              : content.form.invalidEmailError,
          );
          return;
        }

        setEmailError(null);
        submit();
      }}
    >
      <Field label={content.people.inviteEmailLabel} error={emailError ?? undefined} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            type="email"
            inputMode="email"
            autoComplete="email"
            name="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailError(null);
            }}
          />
        )}
      </Field>

      {roles.length > 1 ? (
        <Field label={content.people.inviteRoleLabel} hint={content.roleDescriptions[role]}>
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              name="role"
              value={role}
              options={roleOptions(roles)}
              onChange={(event) => {
                setRole(event.target.value as TenantRole);
              }}
            />
          )}
        </Field>
      ) : (
        // One option is not a choice. State the role and why it is fixed, rather
        // than rendering a select the user cannot change.
        <Field label={content.people.inviteRoleLabel} hint={content.people.roleNotAssignableHint}>
          {({ controlId }) => (
            <StaticFieldValue id={controlId}>{content.roles[role]}</StaticFieldValue>
          )}
        </Field>
      )}

      <TeamSelectionField teams={teams} selectedTeamIds={teamIds} onChange={setTeamIds} />
    </FormDialog>
  );
}
