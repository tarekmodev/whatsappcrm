'use client';

import { useCallback, useState } from 'react';
import {
  InviteCreateInputSchema,
  TENANT_ROLES,
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
import { TeamSelectionField } from './TeamSelectionField';

/**
 * Creates an agent with a role and team memberships. Usage:
 * `<InviteAgentDialog teams={teams} onClose={…} />` — mounted only while open, so
 * its chunk loads on first use.
 *
 * Validation runs against the contract's `InviteCreateInputSchema`, the identical
 * object the API validates with, so the user is not sent on a round trip to learn
 * that an email is malformed.
 */
export function InviteAgentDialog({
  teams,
  onClose,
}: {
  teams: readonly TeamResponse[];
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TenantRole>('agent');
  const [teamIds, setTeamIds] = useState<readonly string[]>([]);
  const [emailError, setEmailError] = useState<string | null>(null);

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

      <Field label={content.people.inviteRoleLabel} hint={content.roleDescriptions[role]}>
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

      <TeamSelectionField teams={teams} selectedTeamIds={teamIds} onChange={setTeamIds} />
    </FormDialog>
  );
}
