'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { useToast } from '@/components/ui/ToastProvider';
import { Stack } from '@/components/layout/Stack';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { AuthForm } from './AuthForm';
import { PasswordField } from './PasswordField';
import { changePasswordAction } from '../auth.actions';
import { validateNewPassword, hasErrors, type NewPasswordErrors } from '../password-policy';
import { useFocusOnMount } from '../useFocusOnMount';
import styles from './ChangePasswordForm.module.css';

/**
 * Changing a known password while signed in. Usage:
 * `<ChangePasswordForm email={principal.email} />`.
 *
 * `currentPassword` is required even though the caller already holds a session,
 * and the contract explains why: a cookie proves the browser has a cookie, not
 * that the person at the keyboard owns the account.
 *
 * Succeeding revokes every *other* session and keeps this one, which is the
 * opposite of the reset flow — so the confirmation says so explicitly rather than
 * leaving somebody to wonder why their phone is asking them to sign in again.
 *
 * `email` is here only for the hidden username field: without one, a password
 * manager has no account to attach the new secret to and quietly saves nothing.
 */
export function ChangePasswordForm({ email }: { email: string }) {
  const content = useContent();
  const { showToast } = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldErrors, setFieldErrors] = useState<NewPasswordErrors>({});
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null);
  const [isChanged, setIsChanged] = useState(false);

  const perform = useCallback(async () => {
    return changePasswordAction({ currentPassword, newPassword: password });
  }, [currentPassword, password]);

  const onSuccess = useCallback(() => {
    // Cleared only on success. A failed submit keeps every field, so nobody has
    // to retype a long password because they mistyped the short one above it.
    setCurrentPassword('');
    setPassword('');
    setConfirmation('');
    setIsChanged(true);
    showToast({ tone: 'success', message: content.auth.changeSuccessToast });
  }, [content, showToast]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  if (isChanged) {
    return (
      <ChangePasswordDone
        onChangeAgain={() => {
          setIsChanged(false);
        }}
      />
    );
  }

  return (
    <AuthForm
      submitLabel={content.auth.changeSubmit}
      pendingLabel={content.auth.changePending}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onSubmit={() => {
        const errors = validateNewPassword(password, confirmation);
        const currentError =
          currentPassword.length === 0 ? content.auth.currentPasswordRequiredError : null;

        setFieldErrors(errors);
        setCurrentPasswordError(currentError);

        if (!hasErrors(errors) && currentError === null) {
          submit();
        }
      }}
    >
      {/*
        Not a control the user fills in — it tells a password manager which
        account the new secret belongs to. `readOnly` rather than `disabled` so it
        is still submitted and still readable, and visually hidden rather than
        `type="hidden"`, which most managers ignore.

        `tabIndex={-1}` because it is visually hidden: leaving it in the tab order
        would give a keyboard user a stop with no visible focus indicator, which
        reads as the focus ring vanishing. It stays labelled and readable, so a
        screen-reader user can still find out which account this form is for.
      */}
      <VisuallyHidden>
        <label>
          {content.auth.signedInAs}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={email}
            readOnly
            tabIndex={-1}
          />
        </label>
      </VisuallyHidden>

      <PasswordField
        label={content.auth.currentPasswordLabel}
        autoComplete="current-password"
        value={currentPassword}
        error={currentPasswordError ?? undefined}
        onChange={(value) => {
          setCurrentPassword(value);
          setCurrentPasswordError(null);
        }}
      />
      <PasswordField
        label={content.auth.newPasswordLabel}
        hasRequirements
        autoComplete="new-password"
        value={password}
        error={fieldErrors.password}
        onChange={(value) => {
          setPassword(value);
          setFieldErrors({});
        }}
      />
      <PasswordField
        label={content.auth.confirmPasswordLabel}
        autoComplete="new-password"
        value={confirmation}
        error={fieldErrors.confirmation}
        onChange={(value) => {
          setConfirmation(value);
          setFieldErrors({});
        }}
      />
    </AuthForm>
  );
}

/**
 * Replaces the form once the change lands. An `h3` under the section's own `h2`,
 * so heading order survives, and it takes focus for the same reason every other
 * outcome in this feature does.
 */
function ChangePasswordDone({ onChangeAgain }: { onChangeAgain: () => void }) {
  const content = useContent();
  const headingRef = useFocusOnMount<HTMLHeadingElement>();

  return (
    <Stack gap="4">
      <h3 ref={headingRef} tabIndex={-1} className={styles.doneHeading}>
        {content.auth.changeDoneHeading}
      </h3>
      <Notice tone="info">{content.auth.changeDoneBody}</Notice>
      <div className={styles.doneActions}>
        <Button variant="secondary" onClick={onChangeAgain}>
          {content.auth.changeAgain}
        </Button>
      </div>
    </Stack>
  );
}
