'use client';

import { useCallback } from 'react';
import Script from 'next/script';
import type { ConnectedWhatsAppBusinessAccountResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { Stepper, StepperStep } from '@/components/ui/Stepper';
import { TextLink } from '@/components/ui/TextLink';
import { useToast } from '@/components/ui/ToastProvider';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { webEnv } from '@/lib/config/env';
import { useContent, type Content } from '@/lib/content';
import { mailto } from '@/lib/mailto';
import { routes } from '@/lib/routes';
import { META_SDK_SRC } from '../embedded-signup';
import { useWhatsAppWizard } from '../useWhatsAppWizard';
import {
  isWhatsAppWizardComplete,
  selectedWhatsAppNumber,
  whatsAppNumberProblem,
  whatsAppWizardResolvedCount,
  WHATSAPP_WIZARD_STEP_IDS,
  type WhatsAppWizardProgress,
} from '../wizard';
import { ConnectedBusinessAccount } from './ConnectedBusinessAccount';
import { WhatsAppConnectStep } from './WhatsAppConnectStep';
import { WhatsAppNumberStep } from './WhatsAppNumberStep';
import { WhatsAppRegistrationStep } from './WhatsAppRegistrationStep';
import { WhatsAppTestSendStep } from './WhatsAppTestSendStep';
import styles from './WhatsAppConnectWizard.module.css';

/**
 * Connecting WhatsApp, as the four steps it actually is (TAR-814). Usage:
 * `<WhatsAppConnectWizard />` — it takes no props, because the flow's only inputs
 * are configuration and the caller's session.
 *
 * This replaces `EmbeddedSignupPanel`, which rendered the whole connection as one
 * button and one result. Everything that panel did is still here, in step one and
 * in `useEmbeddedSignup` unchanged; what is new is that the three facts that used
 * to be footnotes under a success message — which number, whether Meta will let
 * it send, whether anything reaches it — are now steps with their own outcome.
 *
 * Composition only. `useWhatsAppWizard` owns the run and `Stepper` owns the
 * drawing; this decides which body belongs under which step and what each one's
 * summary says.
 *
 * Meta's SDK is loaded here, which is what keeps it to this page: `next/script`
 * mounts with the component, so no other route pays for it or exposes it.
 */
export function WhatsAppConnectWizard() {
  const content = useContent();
  const copy = content.whatsapp.wizard;
  const { showToast } = useToast();

  // Step one going green is a marker changing colour, which a screen reader does
  // not narrate. The toast is what actually announces the connection, through
  // the one polite live region this app has.
  const onConnected = useCallback(
    (account: ConnectedWhatsAppBusinessAccountResponse) => {
      showToast({
        tone: 'success',
        message: content.whatsapp.connectedToast(account.name ?? content.whatsapp.unnamedAccount),
      });
    },
    [content, showToast],
  );

  const wizard = useWhatsAppWizard({ onConnected });

  if (!wizard.signup.isConfigured) {
    // No Meta app on this deployment. An explanation and a way forward, rather
    // than a wizard whose every step can only fail — and rather than silence,
    // which leaves an admin looking for a feature the console appears not to
    // have. The link appears only where the deployment configured an address: a
    // mailto to nowhere is worse than the sentence on its own.
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

  const { progress, statuses, signup } = wizard;
  const total = WHATSAPP_WIZARD_STEP_IDS.length;
  const resolved = whatsAppWizardResolvedCount(statuses);
  const number = selectedWhatsAppNumber(progress);

  return (
    <>
      {/*
        `afterInteractive`: the script is not needed for first paint and must not
        block it, but it is what step one's button does, so deferring it to
        `lazyOnload` would leave that button pending long after the page looked
        ready. It loads once per page load — `next/script` deduplicates by `src`.
      */}
      <Script
        src={META_SDK_SRC}
        strategy="afterInteractive"
        onLoad={signup.onSdkLoad}
        onError={signup.onSdkError}
      />
      <Stack gap="4">
        {/*
          Said before the steps, not inside one: it is true of the whole wizard,
          and `quiet` because it is guidance rather than something that changes
          what the reader can do.
        */}
        {wizard.isRestored ? (
          <Notice tone="info" variant="quiet">
            {copy.restoredNotice}
          </Notice>
        ) : null}

        <Stepper
          label={copy.progressLabel}
          resolved={resolved}
          total={total}
          progressLabel={copy.progressCount(resolved, total)}
        >
          <StepperStep
            position={1}
            status={statuses.connect_account}
            title={copy.steps.connect_account.title}
            statusLabel={copy.statuses[statuses.connect_account]}
            summary={connectSummary(progress, content)}
          >
            <WhatsAppConnectStep
              state={signup.state}
              isSdkLoading={signup.sdkStatus === 'loading'}
              isSdkUnavailable={signup.sdkStatus === 'unavailable'}
              onStart={signup.start}
            />
          </StepperStep>

          <StepperStep
            position={2}
            status={statuses.select_number}
            title={copy.steps.select_number.title}
            statusLabel={copy.statuses[statuses.select_number]}
            summary={
              number === null
                ? copy.steps.select_number.upcoming
                : copy.steps.select_number.done(number.displayPhoneNumber)
            }
          >
            {progress.account === null ? null : (
              <WhatsAppNumberStep
                account={progress.account}
                selectedNumberId={progress.selectedNumberId}
                problem={whatsAppNumberProblem(progress)}
                onSelect={wizard.selectNumber}
                onReconnect={wizard.reset}
              />
            )}
          </StepperStep>

          <StepperStep
            position={3}
            status={statuses.register_number}
            title={copy.steps.register_number.title}
            statusLabel={copy.statuses[statuses.register_number]}
            summary={
              statuses.register_number === 'done'
                ? copy.steps.register_number.done
                : copy.steps.register_number.upcoming
            }
          >
            {number === null ? null : (
              <WhatsAppRegistrationStep
                number={number}
                registration={wizard.registration}
                onRegister={wizard.register}
                onReconnect={wizard.reset}
              />
            )}
          </StepperStep>

          <StepperStep
            position={4}
            status={statuses.test_send}
            title={copy.steps.test_send.title}
            statusLabel={copy.statuses[statuses.test_send]}
            summary={
              statuses.test_send === 'done'
                ? copy.steps.test_send.done
                : copy.steps.test_send.upcoming
            }
          >
            {number === null ? null : (
              <WhatsAppTestSendStep
                number={number}
                inbound={wizard.inbound}
                onCheck={wizard.checkInbound}
              />
            )}
          </StepperStep>
        </Stepper>

        {isWhatsAppWizardComplete(statuses) && progress.account !== null ? (
          <Stack gap="4" className={styles.complete}>
            <Stack gap="2">
              <h3 className={styles.completeHeading}>{copy.completeHeading}</h3>
              <p className={styles.completeBody}>{copy.completeBody}</p>
            </Stack>
            {/*
              The full connection, below the summary rather than instead of it.
              The steps stay on screen when the flow is finished — TAR-36's rule
              for the onboarding checklist and the same one here: a congratulation
              that swallows the list takes the way back with it.
            */}
            <ConnectedBusinessAccount account={progress.account} />
            <Cluster gap="3">
              <ButtonLink href={routes.inbox()} variant="primary">
                {copy.goToInbox}
              </ButtonLink>
              <Button variant="secondary" onClick={wizard.reset}>
                {copy.startAgain}
              </Button>
            </Cluster>
          </Stack>
        ) : null}
      </Stack>
    </>
  );
}

/**
 * Step one's line. Names the business account once there is one, so a wizard
 * restored from storage is checkable at a glance rather than only by opening
 * the completed panel below it.
 */
function connectSummary(progress: WhatsAppWizardProgress, content: Content): string {
  const copy = content.whatsapp.wizard.steps.connect_account;

  return progress.account === null
    ? copy.upcoming
    : copy.done(progress.account.name ?? content.whatsapp.unnamedAccount);
}
