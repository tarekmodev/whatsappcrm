import { ButtonLink } from '@/components/ui/ButtonLink';
import { StateLayout } from '@/components/ui/StateLayout';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';

/**
 * What every screen shows when the API refuses a credential this console was
 * already holding — the token was rotated or revoked underneath an operator.
 *
 * **Never a silent redirect** (spec §2.2). An operator mid-incident needs to know
 * the credential changed, not to wonder why they are back at the front door; a
 * bounce to the credential screen with no explanation reads as a bug in the
 * console rather than a change somebody else made.
 *
 * `role="alert"` because it has replaced the content the operator asked for and
 * they cannot proceed until it is fixed — 0001's rule that a blocking state
 * interrupts while a recoverable one is announced politely.
 *
 * `StateLayout` directly rather than `ErrorState`: this is not a retry, and
 * `ErrorState`'s whole affordance is one. The action here goes somewhere.
 */
export function CredentialRefused() {
  return (
    <StateLayout
      icon="security"
      tone="danger"
      role="alert"
      title={content.credential.refusedMidSessionTitle}
      description={content.credential.refusedMidSessionBody}
      action={
        <ButtonLink href={routes.signIn()} variant="primary">
          {content.credential.refusedMidSessionAction}
        </ButtonLink>
      }
    />
  );
}
