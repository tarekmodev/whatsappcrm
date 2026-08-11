'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionPrincipal } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { signIn } from '../auth.requests';
import { validateEmail, validateRequired } from '../auth.validation';
import { AuthForm } from './AuthForm';
import { PasswordField } from './PasswordField';

/**
 * The sign-in form. Usage: `<LoginForm redirectTo={…} />`.
 *
 * The request runs in the browser rather than through a server action, because
 * the session arrives as a `Set-Cookie` and a cookie set on a server-side fetch
 * belongs to the server. Nothing here reads, stores or forwards a token: the
 * browser holds the cookie and sends it back on its own, and every subsequent
 * server render picks the principal up from it.
 *
 * `redirectTo` has already been narrowed to an in-app path by the page, so a
 * crafted `?next=` cannot bounce a freshly authenticated user off-site.
 */
export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const content = useContent();
  const router = useRouter();
  const { showToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const perform = useCallback(
    async () => signIn({ email: email.trim(), password }),
    [email, password],
  );

  const onSuccess = useCallback(
    (principal: SessionPrincipal) => {
      showToast({ tone: 'success', message: content.auth.signInSuccess(principal.displayName) });
      router.replace(redirectTo);
      // The shell and every page render on the server from the session cookie the
      // response just set, so the cached RSC payload for this navigation is stale
      // by definition.
      router.refresh();
    },
    [content, redirectTo, router, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <AuthForm
      submitLabel={content.auth.signInSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onSubmit={() => {
        const nextEmailError = validateEmail(email.trim());
        const nextPasswordError = validateRequired(password);

        setEmailError(nextEmailError);
        setPasswordError(nextPasswordError);

        if (nextEmailError !== null || nextPasswordError !== null) {
          // Focus the first invalid control, so a keyboard or screen-reader user
          // is put where the problem is rather than left at the submit button.
          (nextEmailError !== null ? emailRef : passwordRef).current?.focus();
          return;
        }

        submit();
      }}
    >
      <Field label={content.auth.emailLabel} error={emailError ?? undefined} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            ref={emailRef}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="off"
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

      <PasswordField
        label={content.auth.passwordLabel}
        value={password}
        autoComplete="current-password"
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
