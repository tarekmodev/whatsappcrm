'use client';

import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import {
  connectFailureCopy,
  isConnectFailureRetryable,
  type WhatsAppConnectFailureReport,
} from '../connect-failure';
import type { EmbeddedSignupState } from '../useEmbeddedSignup';
import styles from './WhatsAppWizardStep.module.css';

/**
 * Step one's body: Meta's Embedded Signup, and the four things a run can be
 * doing. Usage: `<WhatsAppConnectStep state={…} isSdkLoading={…} onStart={…} />`.
 *
 * Lifted out of `EmbeddedSignupPanel`'s `PanelBody` unchanged in behaviour, minus
 * its connected branch — a finished connection is step one being `done`, which
 * the stepper draws, and this body is not rendered at all once it is.
 *
 * The button stays the only control here, for the reason it always was: Meta's
 * authorisation is valid for about 30 seconds and nothing may sit between it
 * arriving and the request going out.
 */
export function WhatsAppConnectStep({
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

  if (state.status === 'failed') {
    return <ConnectFailure report={state.report} onRetry={onStart} />;
  }

  // Meta's script never arrived, and no run has been attempted. The same
  // explanation the failed state would give, before somebody spends a click
  // finding out.
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
      {isBusy ? (
        <ProgressNotice status={state.status === 'connecting' ? 'connecting' : 'authorising'} />
      ) : (
        <p className={styles.intro}>{content.whatsapp.connectIntro}</p>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={onStart}
          // Pending covers both waits the reader is in: the script arriving, and
          // Meta's window being open. In place on the control that caused it,
          // which is the one place this codebase allows a spinner.
          isPending={isSdkLoading || isBusy}
          pendingLabel={content.whatsapp.wizard.steps.connect_account.pendingLabel}
        >
          {content.whatsapp.connectButton}
        </Button>
      </div>
    </Stack>
  );
}

/**
 * What the wait is, in words. Two intervals with genuinely different meanings:
 * Meta's window is open and the reader is in it, or Meta has answered and the
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
 * one, and the retry — offered only where re-running the flow could change the
 * outcome, so nobody is sent back through Meta to be told the same thing.
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
