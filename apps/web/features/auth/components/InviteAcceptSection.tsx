'use client';

import { useCallback, useEffect, useState } from 'react';
import type { InvitePreviewResponse } from '@whatsappcrm/contracts';
import { ErrorState } from '@/components/ui/ErrorState';
import { TextLink } from '@/components/ui/TextLink';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { AuthCard } from './AuthCard';
import { AuthOutcomeCard } from './AuthOutcomeCard';
import { InviteAcceptForm } from './InviteAcceptForm';
import { InviteAcceptSkeleton } from './InviteAcceptForm.Skeleton';
import { InvitePreview } from './InvitePreview';
import { loadInvitePreview } from '../auth.requests';
import { useLinkToken } from '../useLinkToken';

/**
 * The invite-acceptance screen: the router over what the emailed link turned out
 * to carry. Usage: `<InviteAcceptSection />`.
 *
 * Client-rendered by necessity, not by preference — the token is in the URL
 * fragment, which the browser never sends to a server, so no server render can
 * see it (ADR 0005). The same hook the reset screen uses reads and scrubs it.
 *
 * Every outcome is a state with its own copy and its own way out. A dead link is
 * not an error banner: it needs "ask for a new one", which is a different
 * sentence and a different action from "try again".
 */
export function InviteAcceptSection() {
  const content = useContent();
  const token = useLinkToken();

  if (token.status === 'reading') {
    return <InviteAcceptSkeleton />;
  }

  if (token.status === 'missing') {
    return (
      <AuthOutcomeCard
        title={content.auth.inviteUnusableHeading}
        body={content.auth.inviteIncompleteBody}
        actions={<TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>}
      />
    );
  }

  // Keyed by the token, so opening a second invitation in the same tab — a
  // same-document navigation the browser does not remount for — starts over
  // rather than leaving the first link's outcome on screen.
  return <InviteAcceptFields key={token.token} token={token.token} />;
}

/** What the API said about one specific token, and the form for it. */
type LookupState =
  | { status: 'loading' }
  | { status: 'ready'; preview: InvitePreviewResponse }
  | { status: 'dead-link' }
  | { status: 'failed' };

function InviteAcceptFields({ token }: { token: string }) {
  const content = useContent();
  const [state, setState] = useState<LookupState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let isCurrent = true;

    setState({ status: 'loading' });

    void loadInvitePreview(token).then((outcome) => {
      // The screen may have unmounted, or a retry may already be in flight.
      if (!isCurrent) {
        return;
      }

      setState(
        outcome.status === 'ready'
          ? { status: 'ready', preview: outcome.preview }
          : { status: outcome.status },
      );
    });

    return () => {
      isCurrent = false;
    };
  }, [token, attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  /**
   * The state a dead lookup lands in, reached again when the invitation dies
   * between the two requests — the accept re-checks it server-side. The form is
   * replaced rather than annotated, because there is nothing left to submit.
   */
  const showDeadLink = useCallback(() => {
    setState({ status: 'dead-link' });
  }, []);

  if (state.status === 'dead-link') {
    return (
      <AuthOutcomeCard
        title={content.auth.inviteUnusableHeading}
        body={content.auth.inviteDeadLinkBody}
        actions={<TextLink href={routes.login()}>{content.auth.backToSignIn}</TextLink>}
      />
    );
  }

  if (state.status === 'failed') {
    return (
      <AuthCard title={content.auth.inviteTitle}>
        <ErrorState onRetry={retry} />
      </AuthCard>
    );
  }

  if (state.status === 'loading') {
    return <InviteAcceptSkeleton />;
  }

  return (
    <AuthCard title={content.auth.inviteTitle} description={content.auth.inviteDescription}>
      <InvitePreview preview={state.preview} />
      <InviteAcceptForm token={token} preview={state.preview} onDeadLink={showDeadLink} />
    </AuthCard>
  );
}
