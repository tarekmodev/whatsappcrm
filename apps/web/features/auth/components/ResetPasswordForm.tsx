'use client';

import { useCallback, useState } from 'react';
import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { TextLink } from '@/components/ui/TextLink';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { AuthCard } from './AuthCard';
import { AuthForm } from './AuthForm';
import { AuthOutcomeCard } from './AuthOutcomeCard';
import { PasswordField } from './PasswordField';
import { ResetPasswordFormSkeleton } from './ResetPasswordForm.Skeleton';
import { confirmPasswordResetAction, type ResetOutcome } from '../auth.actions';
import { validateNewPassword, hasErrors, type NewPasswordErrors } from '../password-policy';
import { useResetToken } from '../useResetToken';

/**
 * Step two of recovery: redeem the link. Usage: `<ResetPasswordForm />`.
 *
 * This half is the router over what the link turned out to carry:
 *
 *   - **reading** — the token lives in the URL fragment, which is unreadable
 *     until after hydration, so the card holds its shape with a skeleton;
 *   - **missing** — the link arrived without a token, usually truncated by an
 *     email client, and there is nothing to submit;
 *   - **present** — the form below, keyed by the token.
 *
 * The `key` is what makes a *second* link work. Two reset emails differ only by
 * fragment, so opening the newer one from the same tab is a same-document
 * navigation: no reload, no remount, and without the key the screen would keep
 * showing whatever the first link ended at.
 */
export function ResetPasswordForm() {
  const content = useContent();
  const token = useResetToken();

  if (token.status === 'reading') {
    return <ResetPasswordFormSkeleton />;
  }

  if (token.status === 'missing') {
    return (
      <AuthOutcomeCard
        title={content.auth.linkUnusableHeading}
        body={content.auth.linkIncompleteBody}
        actions={
          <>
            <TextLink href={routes.forgotPassword()}>{content.auth.requestNewLink}</TextLink>
            <TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>
          </>
        }
      />
    );
  }

  return <ResetPasswordFields key={token.token} token={token.token} />;
}

/**
 * The form for one specific token, and what the API said about it.
 *
 * A dead link is not rendered as a form error. It comes back through the action's
 * success channel precisely because the right response is to send the user
 * somewhere else, not to let them keep pressing submit — see `ResetOutcome`.
 */
function ResetPasswordFields({ token }: { token: string }) {
  const content = useContent();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldErrors, setFieldErrors] = useState<NewPasswordErrors>({});
  const [outcome, setOutcome] = useState<ResetOutcome | null>(null);

  const perform = useCallback(async () => {
    return confirmPasswordResetAction({ token, password });
  }, [token, password]);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform,
    onSuccess: setOutcome,
  });

  if (outcome?.kind === 'reset') {
    return (
      <AuthOutcomeCard
        title={content.auth.resetDoneHeading}
        body={content.auth.resetDoneBody}
        // TAR-35: a completed reset revokes every session the account had, and
        // the person holding those sessions may not be the person reading this.
        notice={content.auth.resetSessionsRevokedNotice}
        actions={<TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>}
      />
    );
  }

  if (outcome?.kind === 'link_unusable') {
    return (
      <AuthOutcomeCard
        title={content.auth.linkUnusableHeading}
        // The API says which of unknown / expired / used / revoked it was, and
        // that is worth showing: it is the difference between "try the newer
        // email" and "ask an administrator".
        body={outcome.message}
        actions={
          <>
            <TextLink href={routes.forgotPassword()}>{content.auth.requestNewLink}</TextLink>
            <TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>
          </>
        }
      />
    );
  }

  return (
    <AuthCard title={content.auth.resetTitle} description={content.auth.resetDescription}>
      <AuthForm
        submitLabel={content.auth.resetSubmit}
        isPending={isPending}
        formError={formError}
        requestId={requestId}
        footer={<TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>}
        onSubmit={() => {
          const errors = validateNewPassword(password, confirmation);

          setFieldErrors(errors);

          if (!hasErrors(errors)) {
            submit();
          }
        }}
      >
        <PasswordField
          label={content.auth.newPasswordLabel}
          hint={content.auth.passwordHint(AUTH_POLICY.passwordMinLength)}
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
    </AuthCard>
  );
}
