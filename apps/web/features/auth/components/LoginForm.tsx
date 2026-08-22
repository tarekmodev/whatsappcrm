'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionPrincipal } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { TextLink } from '@/components/ui/TextLink';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { AuthCard } from './AuthCard';
import { AuthForm } from './AuthForm';
import { PasswordField } from './PasswordField';
import { signIn } from '../auth.requests';
import { emailFieldError } from '../field-errors';

/**
 * The sign-in screen. Usage: `<LoginForm redirectTo={…} />`.
 *
 * The one form in the console that is **not** a server action, and it has to be:
 * the session arrives as a `Set-Cookie`, and a cookie set on a fetch made by the
 * Next process belongs to the Next process rather than to the person signing in.
 * See `lib/api/auth-browser.ts`. Nothing here reads, stores or forwards a token —
 * the browser holds the cookie and sends it back on its own, and every subsequent
 * server render picks the principal up from it.
 *
 * `redirectTo` is narrowed to an in-app path by the page before it gets here, so
 * a crafted `?next=` cannot bounce a freshly authenticated user off-site.
 */
export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const content = useContent();
  const router = useRouter();
  const { showToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);

  const perform = useCallback(async () => {
    return signIn({ email: email.trim(), password });
  }, [email, password]);

  const onSuccess = useCallback(
    (principal: SessionPrincipal) => {
      showToast({ tone: 'success', message: content.auth.signInSuccess(principal.displayName) });
      router.replace(redirectTo);
      // The shell and every page render on the server from the session cookie the
      // response just set, so the cached payload for this navigation is stale by
      // definition.
      router.refresh();
    },
    [content, redirectTo, router, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <AuthCard title={content.auth.signInTitle} description={content.auth.signInDescription}>
      <AuthForm
        submitLabel={content.auth.signInSubmit}
        pendingLabel={content.auth.signInPending}
        isPending={isPending}
        formError={formError}
        requestId={requestId}
        footer={
          <TextLink href={routes.forgotPassword()}>{content.auth.forgotPasswordLink}</TextLink>
        }
        onSubmit={() => {
          const nextEmailError = emailFieldError(email.trim());
          // The API decides whether the password is right; the console only
          // insists that something was typed, so an empty submit is not a
          // round trip.
          const nextPasswordError =
            password.length === 0 ? content.auth.passwordRequiredError : undefined;

          setEmailError(nextEmailError);
          setPasswordError(nextPasswordError);

          if (nextEmailError === undefined && nextPasswordError === undefined) {
            submit();
          }
        }}
      >
        <Field label={content.auth.emailLabel} error={emailError} isRequired>
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
                setEmailError(undefined);
              }}
            />
          )}
        </Field>

        <PasswordField
          label={content.auth.passwordLabel}
          autoComplete="current-password"
          value={password}
          error={passwordError}
          onChange={(value) => {
            setPassword(value);
            setPasswordError(undefined);
          }}
        />
      </AuthForm>
    </AuthCard>
  );
}
