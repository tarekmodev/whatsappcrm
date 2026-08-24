'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { AuthCard } from '@/features/auth/components/AuthCard';
import { AuthForm } from '@/features/auth/components/AuthForm';
import { PasswordField } from '@/features/auth/components/PasswordField';
import { content } from '~/content/en';
import { presentCredentialAction } from '~/features/credential/credential.actions';

/**
 * The operator credential form. Usage: `<CredentialForm redirectTo={…} />`, with
 * `redirectTo` already narrowed to a path inside this app by the page.
 *
 * ## A credential screen, not a sign-in page (spec §2.2)
 *
 * `PlatformAdminGuard` authenticates a shared bearer token. There is no user, no
 * session, no password and no "forgot". Drawing an email-and-password form here
 * would be a lie about what the credential is, and would train an operator to
 * type a password into a box that wants a secret.
 *
 * The sentence above the field is the only place an operator learns that
 * `actorLabel` on the audit trail is a *credential* and not them, so it is copy
 * rather than decoration.
 *
 * ## Why it reuses `apps/web`'s card, form and field
 *
 * `AuthCard`, `AuthForm` and `PasswordField` are domain-free — a framed panel
 * that owns a page's `<h1>`, a form with its error region, focus-follows-failure
 * and double-submit guard, and a masked input with a reveal control. All three
 * are exactly what this screen needs and none knows anything about sessions or
 * tenants. `PasswordField` in particular: the value is a shared secret typed over
 * somebody's shoulder mid-incident, so masked-with-a-reveal is the right
 * treatment, and `type="password"` also stops a browser remembering it as text.
 *
 * ## What it never does
 *
 * It never receives the credential back. The action verifies the value against
 * the API and puts it in an `httpOnly` cookie server-side; the success payload is
 * `undefined`, so there is nothing here to leak into a log, a toast or the React
 * tree.
 */
export function CredentialForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState<string | undefined>(undefined);

  const perform = useCallback(async () => presentCredentialAction(token), [token]);

  const onSuccess = useCallback(() => {
    router.replace(redirectTo);
    // Every screen renders on the server from the cookie the action just set, so
    // the cached payload for this navigation is stale by definition.
    router.refresh();
  }, [redirectTo, router]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <AuthCard title={content.credential.title}>
      <Stack gap="4">
        <Notice tone="info" variant="quiet">
          {content.credential.intro}
        </Notice>

        <AuthForm
          submitLabel={content.credential.submit}
          pendingLabel={content.credential.pending}
          isPending={isPending}
          formError={formError}
          requestId={requestId}
          onSubmit={() => {
            /*
             * Emptiness, and nothing else. The guard answers one refusal for an
             * absent header, a wrong scheme, a wrong token and an unconfigured
             * environment — so a client-side shape check would hand back the
             * distinction that refusal exists to withhold.
             */
            const nextError =
              token.trim().length === 0 ? content.credential.tokenRequiredError : undefined;

            setTokenError(nextError);

            if (nextError === undefined) {
              submit();
            }
          }}
        >
          <PasswordField
            label={content.credential.tokenLabel}
            error={tokenError}
            // Never offered to a password manager: it is a shared platform
            // credential, not this person's account.
            autoComplete="off"
            value={token}
            onChange={(value) => {
              setToken(value);
              setTokenError(undefined);
            }}
          />
        </AuthForm>
      </Stack>
    </AuthCard>
  );
}
