'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AUTH_POLICY, type InvitePreviewResponse } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { Field } from '@/components/ui/Field';
import { SkeletonBlock, SkeletonLine } from '@/components/ui/Skeleton';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { cx } from '@/lib/cx';
import { routes } from '@/lib/routes';
import { acceptInvitation } from '../auth.requests';
import { validateDisplayName, validateNewPassword } from '../auth.validation';
import { AuthForm } from './AuthForm';
import { PasswordField } from './PasswordField';
import styles from './InviteAcceptForm.module.css';

/**
 * Set a name and a password, get an account and a session. Usage:
 * `<InviteAcceptForm token={token} preview={preview} />`.
 *
 * The body carries a token, a display name and a password — no tenant and no
 * role, and it could not: the tenant comes from the request host and the role
 * from the invitation the admin wrote. The response sets the session cookie, so
 * accepting signs the new agent straight in.
 */
export function InviteAcceptForm({
  token,
  preview,
}: {
  token: string;
  preview: InvitePreviewResponse;
}) {
  const content = useContent();
  const router = useRouter();
  const { showToast } = useToast();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const perform = useCallback(
    async () => acceptInvitation({ token, displayName: displayName.trim(), password }),
    [displayName, password, token],
  );

  const onSuccess = useCallback(() => {
    showToast({ tone: 'success', message: content.auth.inviteSuccess(preview.tenantName) });
    router.replace(routes.inbox());
    // The account did not exist a moment ago, so nothing rendered for it can be
    // reused.
    router.refresh();
  }, [content, preview.tenantName, router, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <AuthForm
      submitLabel={content.auth.inviteSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onSubmit={() => {
        const nextNameError = validateDisplayName(displayName.trim());
        const nextPasswordError = validateNewPassword(password);

        setDisplayNameError(nextNameError);
        setPasswordError(nextPasswordError);

        if (nextNameError !== null || nextPasswordError !== null) {
          (nextNameError !== null ? displayNameRef : passwordRef).current?.focus();
          return;
        }

        submit();
      }}
    >
      <Field
        label={content.auth.inviteDisplayNameLabel}
        hint={content.auth.inviteDisplayNameHint}
        error={displayNameError ?? undefined}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            ref={displayNameRef}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            autoComplete="name"
            name="displayName"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setDisplayNameError(null);
            }}
          />
        )}
      </Field>

      <PasswordField
        label={content.auth.invitePasswordLabel}
        value={password}
        autoComplete="new-password"
        hint={content.auth.passwordLengthHint(AUTH_POLICY.passwordMinLength)}
        error={passwordError ?? undefined}
        inputRef={passwordRef}
        onChange={(value) => {
          setPassword(value);
          setPasswordError(null);
        }}
      />
    </AuthForm>
  );
}

/**
 * The placeholder for the same form: the same `Stack` gaps, two label/hint/control
 * groups at the same `Field` rhythm, and a submit-height block — so the form
 * arriving under the preview does not push the card taller.
 */
export function InviteAcceptFormSkeleton() {
  return (
    <Stack gap="4">
      {PLACEHOLDER_FIELDS.map(({ label, hint }) => (
        <Stack key={label} gap="2">
          <span className={cx(styles.label, styles.placeholderLine)}>
            <SkeletonLine width={label} />
          </span>
          <span className={cx(styles.hint, styles.placeholderLine)}>
            <SkeletonLine width={hint} />
          </span>
          <SkeletonBlock height="var(--size-touch-target)" />
        </Stack>
      ))}
      <SkeletonBlock height="var(--size-touch-target)" />
    </Stack>
  );
}

/** Label and hint widths, at roughly the length of the copy they stand in for. */
const PLACEHOLDER_FIELDS = [
  { label: '5rem', hint: '15rem' },
  { label: '9rem', hint: '8rem' },
] as const;
