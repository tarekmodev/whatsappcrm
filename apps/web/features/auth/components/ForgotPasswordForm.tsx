'use client';

import { useCallback, useState } from 'react';
import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { TextLink } from '@/components/ui/TextLink';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { AuthCard } from './AuthCard';
import { AuthForm } from './AuthForm';
import { AuthOutcomeCard } from './AuthOutcomeCard';
import { requestPasswordResetAction } from '../auth.actions';
import { emailFieldError } from '../field-errors';

/**
 * Step one of recovery: ask for a link. Usage: `<ForgotPasswordForm />`.
 *
 * **It never says whether the address exists.** The API answers 204 for a real
 * address, an unknown one, a suspended account and a throttled request alike, and
 * this screen has to hold that line — one confirmation, worded the same way every
 * time, whatever came back. A different message for a different case would put
 * the user-enumeration oracle back on the other side of the same endpoint.
 *
 * There is therefore no error state for "no such account" to render. The only
 * failure the user can see is a transport one, which is a real failure and does
 * say so.
 */
export function ForgotPasswordForm() {
  const content = useContent();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const perform = useCallback(async () => {
    return requestPasswordResetAction({ email: email.trim() });
  }, [email]);

  const onSuccess = useCallback(({ email: requestedFor }: { email: string }) => {
    setSentTo(requestedFor);
  }, []);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  if (sentTo !== null) {
    return (
      <AuthOutcomeCard
        title={content.auth.forgotSentHeading}
        body={content.auth.forgotSentBody(sentTo)}
        detail={content.auth.forgotSentExpiry(RESET_LINK_TTL_MINUTES)}
        notice={content.auth.forgotSentHint}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                // Back to the form with the address still in it: the usual reason
                // to be here is a typo, and retyping the whole thing to fix one
                // character is the wrong ask.
                setSentTo(null);
              }}
            >
              {content.auth.forgotSendAgain}
            </Button>
            <TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>
          </>
        }
      />
    );
  }

  return (
    <AuthCard title={content.auth.forgotTitle} description={content.auth.forgotDescription}>
      <AuthForm
        submitLabel={content.auth.forgotSubmit}
        isPending={isPending}
        formError={formError}
        requestId={requestId}
        footer={<TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>}
        onSubmit={() => {
          const nextEmailError = emailFieldError(email.trim());

          setEmailError(nextEmailError ?? null);

          if (nextEmailError === undefined) {
            submit();
          }
        }}
      >
        <Field label={content.auth.emailLabel} error={emailError ?? undefined} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              name="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
            />
          )}
        </Field>
      </AuthForm>
    </AuthCard>
  );
}

/**
 * Derived from the contract rather than written down, so the copy cannot promise
 * a window the API does not honour.
 */
const MS_PER_MINUTE = 60_000;
const RESET_LINK_TTL_MINUTES = AUTH_POLICY.passwordResetTtlMs / MS_PER_MINUTE;
