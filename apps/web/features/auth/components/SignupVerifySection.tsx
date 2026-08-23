'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignupCompletedResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { AuthCard } from './AuthCard';
import { AuthOutcomeCard } from './AuthOutcomeCard';
import { SignupVerifySkeleton } from './SignupVerifySection.Skeleton';
import { completeSignup, type SignupVerification } from '../signup.requests';
import { useLinkToken } from '../useLinkToken';

/**
 * The target of the signup verification email: the router over what the link
 * turned out to carry. Usage: `<SignupVerifySection />`.
 *
 * Client-rendered by necessity rather than by preference — the token is in the
 * URL **fragment**, which the browser never sends to a server, so no server
 * render can see it (ADR 0005). The same hook the reset and invite screens use
 * reads it and scrubs it from the address bar.
 *
 * The `key` is what makes a *second* link work. Two verification emails differ
 * only by fragment, so opening the newer one in the same tab is a same-document
 * navigation with no reload and no remount — and without the key the screen
 * would keep showing whatever the first link ended at.
 */
export function SignupVerifySection() {
  const content = useContent();
  const token = useLinkToken();

  if (token.status === 'reading') {
    return <SignupVerifySkeleton />;
  }

  if (token.status === 'missing') {
    return (
      <AuthOutcomeCard
        icon="warning"
        tone="danger"
        title={content.auth.verifyUnusableHeading}
        body={content.auth.verifyIncompleteBody}
        action={
          <ButtonLink href={routes.signup()} variant="primary" isBlock>
            {content.auth.signupStartAgain}
          </ButtonLink>
        }
      />
    );
  }

  return <SignupVerifyOutcome key={token.token} token={token.token} />;
}

/**
 * One token, spent once.
 *
 * ## Why there is no button to press
 *
 * `SignupInputSchema` took the password on the *signup* form, precisely so that
 * this step only confirms — a verify page that asked for a credential would be a
 * page an attacker holding an intercepted link could complete. What is left here
 * is a confirmation with a single possible input, and putting that behind a
 * button would be asking somebody who has already clicked a link in their email
 * to click a second one that says the same thing.
 *
 * ## Why it cannot run twice
 *
 * The token is single-use: a second call spends nothing and answers
 * `token_invalid`, which would turn a successful signup into a dead-link screen.
 * `useActionForm`'s in-flight guard covers two calls in the same tick and the ref
 * below covers a later re-run — Strict Mode in development, an error-boundary
 * reset or a Suspense retry in production.
 */
function SignupVerifyOutcome({ token }: { token: string }) {
  const content = useContent();
  const [verification, setVerification] = useState<SignupVerification | null>(null);
  const hasStartedRef = useRef(false);

  const perform = useCallback(async () => completeSignup(token), [token]);

  const { submit, isPending, formError, requestId } = useActionForm({
    perform,
    onSuccess: setVerification,
  });

  useEffect(() => {
    if (hasStartedRef.current) {
      return;
    }

    hasStartedRef.current = true;
    submit();
  }, [submit]);

  if (verification?.kind === 'completed') {
    return <SignupCompletedCard completed={verification.completed} />;
  }

  if (verification?.kind === 'dead_link') {
    return (
      <AuthOutcomeCard
        icon="warning"
        tone="danger"
        title={content.auth.verifyUnusableHeading}
        body={content.auth.verifyDeadLinkBody}
        action={
          <ButtonLink href={routes.signup()} variant="primary" isBlock>
            {content.auth.signupStartAgain}
          </ButtonLink>
        }
      />
    );
  }

  if (verification?.kind === 'disabled') {
    return (
      <AuthOutcomeCard
        icon="warning"
        tone="danger"
        title={content.auth.signupDisabledHeading}
        body={content.auth.signupDisabledBody}
        action={
          <ButtonLink href={routes.login()} variant="primary" isBlock>
            {content.auth.backToSignIn}
          </ButtonLink>
        }
      />
    );
  }

  /*
   * A transport failure, and the one state here with a way back into the same
   * request. Retrying is safe *and* useful: if the token was spent after all,
   * the second attempt answers `token_invalid` and lands on the dead-link card,
   * which is the right screen — and if it was not, this is the only way to
   * finish without asking for another email.
   */
  if (formError !== null) {
    return (
      <AuthCard icon="warning" tone="danger" title={content.auth.verifyTitle}>
        <Stack gap="4">
          <FormError message={formError} requestId={requestId} shouldTakeFocus />
          <Button
            variant="primary"
            isBlock
            onClick={() => {
              submit();
            }}
          >
            {content.auth.verifyRetry}
          </Button>
        </Stack>
      </AuthCard>
    );
  }

  // Still in flight, or about to be: the effect above has not run on the very
  // first render, and provisioning a workspace is not instant.
  return <SignupVerifySkeleton isProvisioning={isPending} />;
}

/**
 * The workspace exists. Now hand the new administrator over to it.
 *
 * ## The one awkward step, and why it is not a bug
 *
 * The session cookie `POST /signup/verify` just set is scoped to the **platform**
 * host this page is served on: it carries a `__Host-` prefix and no `Domain`,
 * which a browser enforces (`apps/api/src/identity/session-cookie.ts`). That is
 * a deliberate cross-tenant safeguard — a cookie scoped to the parent domain
 * would be sent to every tenant subdomain under it — and it means the session
 * cannot follow the redirect to the workspace's own hostname.
 *
 * So this card sends them to their workspace's **sign-in** page with
 * `?next=/onboarding`, and says why before it happens. They sign in once with
 * the password they chose minutes ago and land on the checklist, which is what
 * TAR-36's acceptance criteria ask for: a tenant provisioned, and the visitor in
 * onboarding rather than at a dead end.
 *
 * The scheme comes from the page this is rendered on rather than being assumed:
 * the platform host and the tenant subdomain are the same deployment behind the
 * same edge, so whatever served this served that.
 */
function SignupCompletedCard({ completed }: { completed: SignupCompletedResponse }) {
  const content = useContent();
  const workspaceUrl = `${window.location.protocol}//${completed.primaryHostname}${routes.login({
    redirectTo: routes.onboarding(),
  })}`;

  return (
    <AuthOutcomeCard
      icon="check"
      tone="success"
      title={content.auth.verifyDoneHeading(completed.tenant.name)}
      body={content.auth.verifyDoneBody(completed.primaryHostname)}
      notice={content.auth.verifySignInNotice}
      action={
        // `isExternal`, so it is a plain anchor: `next/link` would try to
        // prefetch and client-route a host this app is not running on.
        <ButtonLink href={workspaceUrl} variant="primary" isBlock isExternal>
          {content.auth.verifyOpenWorkspace}
        </ButtonLink>
      }
    />
  );
}
