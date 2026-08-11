'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { InvitePreviewResponse } from '@whatsappcrm/contracts';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { loadInvitePreview } from '../auth.requests';
import { readInviteToken } from '../invite-token';
import { AuthCard } from './AuthCard';
import { InviteAcceptForm, InviteAcceptFormSkeleton } from './InviteAcceptForm';
import { InvitePreview, InvitePreviewSkeleton } from './InvitePreview';
import styles from './InviteAcceptSection.module.css';

/**
 * The invite-acceptance screen, and the one component on it that knows the token
 * exists. Usage: `<InviteAcceptSection />`.
 *
 * Client-rendered by necessity, not by preference: the token arrives in the URL
 * *fragment*, which the browser never sends to a server, so no server render can
 * see it (ADR 0005). The fragment is left intact so a refresh mid-typing still
 * works — clearing it is TAR-53's instruction for the reset screen, whose link is
 * the one that lands in a chat window.
 *
 * Every outcome of the lookup is a state with its own copy and its own way out. A
 * dead link is not an error banner: it needs "ask for a new one", which is a
 * different sentence and a different action from "try again".
 */

type LookupState =
  | { status: 'loading' }
  | { status: 'missing-token' }
  | { status: 'ready'; token: string; preview: InvitePreviewResponse }
  | { status: 'dead-link' }
  | { status: 'failed' };

export function InviteAcceptSection() {
  const content = useContent();
  const [state, setState] = useState<LookupState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const token = readInviteToken(window.location.hash);

    if (token === null) {
      setState({ status: 'missing-token' });
      return;
    }

    let isCurrent = true;

    setState({ status: 'loading' });

    void loadInvitePreview(token).then((outcome) => {
      // The screen may have unmounted, or a retry may already be in flight.
      if (!isCurrent) {
        return;
      }

      setState(
        outcome.status === 'ready'
          ? { status: 'ready', token, preview: outcome.preview }
          : { status: outcome.status },
      );
    });

    return () => {
      isCurrent = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  if (state.status === 'missing-token') {
    return (
      <InviteProblemCard
        title={content.auth.inviteMissingTokenHeading}
        body={content.auth.inviteMissingTokenBody}
      />
    );
  }

  if (state.status === 'dead-link') {
    return (
      <InviteProblemCard
        title={content.auth.inviteDeadLinkHeading}
        body={content.auth.inviteDeadLinkBody}
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
    return (
      <AuthCard title={content.auth.inviteTitle} description={content.auth.inviteDescription}>
        {/*
          Shown immediately rather than after an anti-flash delay: this is the
          screen's first paint, so delaying it would show an empty card instead of
          a faster one. The delay rule is about swapping content already on screen.
        */}
        <LoadingAnnouncement label={content.auth.inviteLoading} />
        <InvitePreviewSkeleton />
        <InviteAcceptFormSkeleton />
      </AuthCard>
    );
  }

  return (
    <AuthCard title={content.auth.inviteTitle} description={content.auth.inviteDescription}>
      <InvitePreview preview={state.preview} />
      <InviteAcceptForm token={state.token} preview={state.preview} />
    </AuthCard>
  );
}

/**
 * A link that cannot be used, whatever the reason. There is nothing to retry, so
 * the only action offered is the one that still works.
 */
function InviteProblemCard({ title, body }: { title: string; body: string }) {
  const content = useContent();

  return (
    <AuthCard title={title} description={body}>
      <Link href={routes.login()} className={styles.link}>
        {content.auth.goToSignIn}
      </Link>
    </AuthCard>
  );
}
