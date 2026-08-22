'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { InvitePreviewResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { TextLink } from '@/components/ui/TextLink';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { AuthForm } from './AuthForm';
import { PasswordField } from './PasswordField';
import { acceptInvitation, type AcceptedInvite } from '../auth.requests';
import { displayNameFieldError } from '../field-errors';
import { hasErrors, validateNewPassword, type NewPasswordErrors } from '../password-policy';

/**
 * Set a name and a password, get an account and a session. Usage:
 * `<InviteAcceptForm token={token} preview={preview} onDeadLink={…} />`.
 *
 * The body carries a token, a display name and a password — no tenant and no
 * role, and it could not: the tenant comes from the request host and the role
 * from the invitation the admin wrote. The response sets the session cookie, so
 * accepting signs the new agent straight in.
 *
 * `onDeadLink` exists because the API re-checks the invitation when it accepts:
 * a link that was live at lookup can be expired, withdrawn or already used by the
 * time this submits, and the answer to that is a different screen rather than a
 * message above a form that can no longer succeed however it is filled in.
 */
export function InviteAcceptForm({
  token,
  preview,
  onDeadLink,
}: {
  token: string;
  preview: InvitePreviewResponse;
  onDeadLink: () => void;
}) {
  const content = useContent();
  const router = useRouter();
  const { showToast } = useToast();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [displayNameError, setDisplayNameError] = useState<string | undefined>(undefined);
  const [passwordErrors, setPasswordErrors] = useState<NewPasswordErrors>({});

  const perform = useCallback(async () => {
    return acceptInvitation({ token, displayName: displayName.trim(), password });
  }, [displayName, password, token]);

  const onSuccess = useCallback(
    (accepted: AcceptedInvite) => {
      if (accepted === null) {
        onDeadLink();
        return;
      }

      showToast({ tone: 'success', message: content.auth.inviteSuccess(preview.tenantName) });
      router.replace(routes.inbox());
      // The account did not exist a moment ago, so nothing rendered for it can be
      // reused.
      router.refresh();
    },
    [content, onDeadLink, preview.tenantName, router, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <AuthForm
      submitLabel={content.auth.inviteSubmit}
      pendingLabel={content.auth.invitePending}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      footer={<TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>}
      onSubmit={() => {
        const nextNameError = displayNameFieldError(displayName.trim());
        const nextPasswordErrors = validateNewPassword(password, confirmation);

        setDisplayNameError(nextNameError);
        setPasswordErrors(nextPasswordErrors);

        if (nextNameError === undefined && !hasErrors(nextPasswordErrors)) {
          submit();
        }
      }}
    >
      <Field
        label={content.auth.inviteDisplayNameLabel}
        hint={content.auth.inviteDisplayNameHint}
        error={displayNameError}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            autoComplete="name"
            name="displayName"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setDisplayNameError(undefined);
            }}
          />
        )}
      </Field>

      <PasswordField
        label={content.auth.invitePasswordLabel}
        hasRequirements
        autoComplete="new-password"
        value={password}
        error={passwordErrors.password}
        onChange={(value) => {
          setPassword(value);
          setPasswordErrors({});
        }}
      />

      <PasswordField
        label={content.auth.confirmPasswordLabel}
        autoComplete="new-password"
        value={confirmation}
        error={passwordErrors.confirmation}
        onChange={(value) => {
          setConfirmation(value);
          setPasswordErrors({});
        }}
      />
    </AuthForm>
  );
}
