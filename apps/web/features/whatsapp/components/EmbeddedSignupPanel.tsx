'use client';

import { useCallback } from 'react';
import Script from 'next/script';
import type { ConnectedWhatsAppBusinessAccountResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Notice } from '@/components/ui/Notice';
import { TextLink } from '@/components/ui/TextLink';
import { useToast } from '@/components/ui/ToastProvider';
import { Stack } from '@/components/layout/Stack';
import { webEnv } from '@/lib/config/env';
import { useContent } from '@/lib/content';
import { mailto } from '@/lib/mailto';
import { META_SDK_SRC } from '../embedded-signup';
import {
  connectFailureCopy,
  isConnectFailureRetryable,
  type WhatsAppConnectFailureReport,
} from '../connect-failure';
import { useEmbeddedSignup, type EmbeddedSignupState } from '../useEmbeddedSignup';
import { ConnectedBusinessAccount } from './ConnectedBusinessAccount';
import styles from './EmbeddedSignupPanel.module.css';

/**
 * The console's half of Meta's Embedded Signup. Usage:
 * `<EmbeddedSignupPanel />` — it takes no props, because the flow's only inputs
 * are configuration and the caller's session.
 *
 * The whole of the flow lives in `useEmbeddedSignup`; this renders the five
 * states it can be in and owns nothing else. Meta's SDK is loaded here, which is
 * what keeps it to this page: `next/script` mounts with the component, so no
 * other route in the console pays for it or exposes it.
 *
 * The button is deliberately the only control on the panel. There is no form and
 * no confirmation step between Meta answering and the request going out, because
 * Meta's authorisation is valid for about 30 seconds and anything that spends
 * them spends the whole run.
 */
export function EmbeddedSignupPanel() {
  const content = useContent();
  const { showToast } = useToast();

  const onConnected = useCallback(
    (account: ConnectedWhatsAppBusinessAccountResponse) => {
      showToast({
        tone: 'success',
        message: content.whatsapp.connectedToast(account.name ?? content.whatsapp.unnamedAccount),
      });
    },
    [content, showToast],
  );

  const { state, sdkStatus, isConfigured, onSdkLoad, onSdkError, start } = useEmbeddedSignup({
    onConnected,
  });

  if (!isConfigured) {
    // No Meta app on this deployment. An explanation and a way forward, rather
    // than a button that can only ever fail — and rather than silence, which
    // leaves an admin looking for a feature the console appears not to have.
    //
    // The copy instructs "contact support", so the state offers it. The link
    // appears only where the deployment configured an address: a mailto to
    // nowhere is worse than the sentence on its own.
    return (
      <EmptyState
        icon="settings"
        title={content.whatsapp.unconfiguredHeading}
        description={content.whatsapp.unconfiguredBody}
        action={
          webEnv.supportEmail === null ? undefined : (
            <TextLink
              isExternal
              href={mailto(webEnv.supportEmail, content.whatsapp.unconfiguredSupportSubject)}
            >
              {content.whatsapp.unconfiguredSupportAction}
            </TextLink>
          )
        }
      />
    );
  }

  return (
    <>
      {/*
        `afterInteractive`: the script is not needed for first paint and must not
        block it, but it is what the one button on this page does, so deferring it
        to `lazyOnload` would leave that button pending long after the page looked
        ready. It loads once per page load — `next/script` deduplicates by `src`.
      */}
      <Script
        src={META_SDK_SRC}
        strategy="afterInteractive"
        onLoad={onSdkLoad}
        onError={onSdkError}
      />
      <PanelBody
        state={state}
        isSdkLoading={sdkStatus === 'loading'}
        isSdkUnavailable={sdkStatus === 'unavailable'}
        onStart={start}
      />
    </>
  );
}

function PanelBody({
  state,
  isSdkLoading,
  isSdkUnavailable,
  onStart,
}: {
  state: EmbeddedSignupState;
  isSdkLoading: boolean;
  isSdkUnavailable: boolean;
  onStart: () => void;
}) {
  const content = useContent();

  if (state.status === 'connected') {
    return (
      <Stack gap="4">
        <ConnectedBusinessAccount account={state.account} />
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onStart}>
            {content.whatsapp.connectAnotherButton}
          </Button>
        </div>
      </Stack>
    );
  }

  if (state.status === 'failed') {
    return <ConnectFailure report={state.report} onRetry={onStart} />;
  }

  // Meta's script never arrived, and no run has been attempted. Same explanation
  // the failed state would give, before somebody spends a click finding out.
  if (isSdkUnavailable) {
    return (
      <ConnectFailure
        report={{ failure: 'sdk_unavailable', detail: null, requestId: null }}
        onRetry={onStart}
      />
    );
  }

  const isBusy = state.status === 'authorising' || state.status === 'connecting';

  return (
    <Stack gap="4">
      {state.status === 'idle' ? (
        <p className={styles.intro}>{content.whatsapp.connectIntro}</p>
      ) : (
        <ProgressNotice status={state.status} />
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={onStart}
          // Pending covers both waits the user is in: the script arriving, and
          // Meta's window being open. In-place on the control that caused it,
          // which is the one place this codebase allows a spinner.
          isPending={isSdkLoading || isBusy}
        >
          {content.whatsapp.connectButton}
        </Button>
      </div>
    </Stack>
  );
}

/**
 * What the wait is, in words. Two intervals with genuinely different meanings:
 * Meta's window is open and the user is in it, or Meta has answered and the
 * account is being set up — during which nobody should navigate away.
 */
function ProgressNotice({ status }: { status: 'authorising' | 'connecting' }) {
  const content = useContent();
  const isConnecting = status === 'connecting';

  return (
    <Stack gap="2">
      <p className={styles.statusHeading}>
        {isConnecting ? content.whatsapp.connectingHeading : content.whatsapp.authorisingHeading}
      </p>
      <Notice tone="info">
        {isConnecting ? content.whatsapp.connectingBody : content.whatsapp.authorisingBody}
      </Notice>
    </Stack>
  );
}

/**
 * A failed run, with the copy its reason earns.
 *
 * `ErrorState` gives it `role="alert"`, the correlation id when the API supplied
 * one, and the retry affordance — offered only where re-running the flow could
 * actually change the outcome, so nobody is sent back through Meta to be told the
 * same thing.
 *
 * `detail` is the API's own authored message and appears only where this build
 * has nothing more specific than "the connection could not be completed" — see
 * `WhatsAppConnectFailureReport`.
 */
function ConnectFailure({
  report,
  onRetry,
}: {
  report: WhatsAppConnectFailureReport;
  onRetry: () => void;
}) {
  const copy = connectFailureCopy(report.failure);

  return (
    <ErrorState
      title={copy.heading}
      description={report.detail ?? copy.body}
      requestId={report.requestId}
      onRetry={isConnectFailureRetryable(report.failure) ? onRetry : undefined}
    />
  );
}
