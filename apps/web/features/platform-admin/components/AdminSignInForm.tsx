'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { AuthCard } from '@/features/auth/components/AuthCard';
import { AuthForm } from '@/features/auth/components/AuthForm';
import { PasswordField } from '@/features/auth/components/PasswordField';
import { signInToPlatformConsoleAction } from '../platform-admin.actions';

/**
 * The platform-operator credential form. Usage:
 * `<AdminSignInForm redirectTo={…} />`, with `redirectTo` already narrowed to a
 * path inside `/admin` by the page.
 *
 * ## Why it reuses `features/auth`'s card, form and field
 *
 * `AuthCard`, `AuthForm` and `PasswordField` are domain-free — a framed panel
 * that owns a page's `<h1>`, a form with its error region and double-submit
 * guard, and a masked input with a reveal control. All three are exactly what
 * this screen needs and none of them knows anything about sessions or tenants, so
 * a second copy under this feature would be a fork that drifts. They live under
 * `features/auth` because that is where they were first needed; promoting them to
 * `components/ui/` is worth doing and is not this story's diff.
 *
 * ## Why the token is a `PasswordField`
 *
 * It is a shared secret being typed, often over somebody's shoulder in an
 * incident. Masked by default with a reveal control is the right treatment for
 * that, and it is the one this app already has — `type="password"` also stops a
 * browser or a password manager from remembering it as an ordinary text value.
 *
 * ## What it does not do
 *
 * It never receives the credential back. The action verifies the value against
 * the API and puts it in an `httpOnly` cookie server-side; the success payload is
 * `undefined`, so there is nothing here to leak into a log, a toast or the React
 * tree.
 */
export function AdminSignInForm({ redirectTo }: { redirectTo: string }) {
  const content = useContent();
  const router = useRouter();
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState<string | undefined>(undefined);

  const perform = useCallback(async () => signInToPlatformConsoleAction(token), [token]);

  const onSuccess = useCallback(() => {
    router.replace(redirectTo);
    // Every operator screen renders on the server from the cookie the action just
    // set, so the cached payload for this navigation is stale by definition.
    router.refresh();
  }, [redirectTo, router]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <AuthCard
      title={content.platformAdmin.signIn.title}
      description={content.platformAdmin.signIn.description}
    >
      <Stack gap="4">
        <AuthForm
          submitLabel={content.platformAdmin.signIn.submit}
          pendingLabel={content.platformAdmin.signIn.pending}
          isPending={isPending}
          formError={formError}
          requestId={requestId}
          onSubmit={() => {
            /*
             * Emptiness, and nothing else. The API's guard answers one refusal
             * for an absent header, a wrong scheme, a wrong token and an
             * unconfigured environment — so a client-side shape check would hand
             * back the distinction that refusal exists to withhold.
             */
            const nextTokenError =
              token.trim().length === 0
                ? content.platformAdmin.signIn.tokenRequiredError
                : undefined;

            setTokenError(nextTokenError);

            if (nextTokenError === undefined) {
              submit();
            }
          }}
        >
          <PasswordField
            label={content.platformAdmin.signIn.tokenLabel}
            hint={content.platformAdmin.signIn.tokenHint}
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

        <Notice tone="info" variant="quiet">
          {content.platformAdmin.signIn.sharedCredentialNotice}
        </Notice>
      </Stack>
    </AuthCard>
  );
}
