'use client';

import type { WhatsAppAccountResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { ErrorState } from '@/components/ui/ErrorState';
import { Notice } from '@/components/ui/Notice';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import type { WhatsAppInboundState } from '../useWhatsAppWizard';
import styles from './WhatsAppWizardStep.module.css';

/**
 * Step four's body: proving the round trip. Usage:
 * `<WhatsAppTestSendStep number={…} inbound={…} onCheck={…} />`.
 *
 * ## Why the reader messages the number, and not the other way round
 *
 * The step is called "test send" and it is a **test receive**, deliberately.
 * WhatsApp does not let a business open a conversation with free-form text — only
 * with a template Meta has approved — and a freshly connected account has no
 * approved templates, so there is no message this console could send to prove
 * anything. There is also no endpoint that could: `POST
 * /v1/conversations/{id}/messages` is addressed to a conversation, and a
 * conversation exists only once a customer has written in.
 *
 * So the direction that works is the one that proves more. A message arriving
 * means Meta's webhook reached us, the routing key resolved to this number and
 * the tenant scoping held — the whole path, not half of it — and it opens the
 * 24-hour service window in which a reply from the inbox tests sending for real.
 * The copy says all of that, because a reader who is not told will read it as a
 * missing feature.
 *
 * ## The wait ends
 *
 * One press watches for a minute and then stops, saying what it saw. A settings
 * page that keeps polling after the reader has moved on is a background job
 * nobody asked for.
 */
export function WhatsAppTestSendStep({
  number,
  inbound,
  onCheck,
}: {
  number: WhatsAppAccountResponse;
  inbound: WhatsAppInboundState;
  onCheck: () => void;
}) {
  const content = useContent();
  const copy = content.whatsapp.wizard.steps.test_send;

  if (inbound.error !== null) {
    return (
      <ErrorState
        title={content.whatsapp.wizard.requestFailedHeading}
        description={inbound.error.message ?? content.whatsapp.wizard.requestFailedBody}
        requestId={inbound.error.requestId}
        onRetry={onCheck}
      />
    );
  }

  return (
    <Stack gap="3">
      <p className={styles.intro}>{copy.current(number.displayPhoneNumber)}</p>
      {/*
        Nothing arrived inside the minute this press bought. A warning and not an
        error state: the connection is not broken, the message simply has not
        turned up yet, and replacing the instructions with a red box would take
        away the number the reader still has to send to.
      */}
      {inbound.hasGivenUp ? (
        <Stack gap="2">
          <p className={styles.statusHeading}>{copy.notSeenHeading}</p>
          <Notice tone="warning">{copy.notSeenBody}</Notice>
        </Stack>
      ) : null}
      <Cluster gap="3" className={styles.actions}>
        <Button
          variant="primary"
          onClick={onCheck}
          isPending={inbound.isChecking}
          // Not "Saving…": this is watching an inbox, and the announcement stays
          // inside the button rather than adding a second live region beside it.
          pendingLabel={copy.pendingLabel}
        >
          {copy.action}
        </Button>
        <ButtonLink href={routes.inbox()} variant="ghost">
          {content.whatsapp.wizard.goToInbox}
        </ButtonLink>
      </Cluster>
    </Stack>
  );
}
