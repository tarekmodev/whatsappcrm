'use client';

import type { WhatsAppAccountResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import {
  isRegistrationFailureReconnectable,
  isRegistrationFailureRetryable,
} from '../presentation';
import type { WhatsAppRegistrationState } from '../useWhatsAppWizard';
import styles from './WhatsAppWizardStep.module.css';

/**
 * Step three's body: getting Meta to register the number for sending (TAR-170's
 * route, TAR-814's step). Usage:
 * `<WhatsAppRegistrationStep number={…} registration={…} onRegister={…} onReconnect={…} />`.
 *
 * ## Why this is a step of its own
 *
 * Registration already runs automatically as the last act of Embedded Signup.
 * When it works, this step arrives `done` and the reader presses nothing. It
 * exists for when it did not — a throttle, a Meta outage, a two-step PIN this
 * platform does not hold — because the state it leaves behind is invisible from
 * everywhere else in the console: the number receives normally and refuses every
 * send.
 *
 * ## Three answers, not two
 *
 * `pending` is neither success nor refusal. Meta has an attempt in flight, or one
 * died without an answer, and the route short-circuits rather than starting a
 * second — so the control asks again instead of registering again, and says so.
 *
 * A refusal is a `200` with the reason in the body (0002, amendment 12), which is
 * why the copy branches on `registrationFailureReason` and not on an error
 * envelope. Whether a retry is offered, and which one, is
 * `presentation.ts`'s decision — copy stays copy.
 */
export function WhatsAppRegistrationStep({
  number,
  registration,
  onRegister,
  onReconnect,
}: {
  number: WhatsAppAccountResponse;
  registration: WhatsAppRegistrationState;
  onRegister: () => void;
  /** Back through Embedded Signup, for the one refusal only fresh access clears. */
  onReconnect: () => void;
}) {
  const content = useContent();
  const copy = content.whatsapp.wizard.steps.register_number;

  // A request that did not reach the API, or one it refused outright — never a
  // registration Meta turned down, which arrives as data below.
  if (registration.error !== null) {
    return (
      <ErrorState
        title={content.whatsapp.wizard.requestFailedHeading}
        description={registration.error.message ?? content.whatsapp.wizard.requestFailedBody}
        requestId={registration.error.requestId}
        onRetry={onRegister}
      />
    );
  }

  const reason = number.registrationFailureReason;

  if (number.registrationStatus === 'failed' && reason !== null) {
    const failure = content.whatsapp.wizard.registrationFailures[reason];
    const isReconnect = isRegistrationFailureReconnectable(reason);

    return (
      <ErrorState
        title={failure.heading}
        description={failure.body}
        onRetry={
          isReconnect
            ? onReconnect
            : isRegistrationFailureRetryable(reason)
              ? onRegister
              : undefined
        }
        retryLabel={isReconnect ? copy.reconnectAction : copy.retryAction}
      />
    );
  }

  if (number.registrationStatus === 'pending') {
    return (
      <Stack gap="3">
        <p className={styles.statusHeading}>{copy.pendingHeading}</p>
        <Notice tone="info">{copy.pendingBody}</Notice>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onRegister} isPending={registration.isPending}>
            {copy.checkAction}
          </Button>
        </div>
      </Stack>
    );
  }

  return (
    <Stack gap="3">
      <p className={styles.intro}>{copy.current}</p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={onRegister}
          isPending={registration.isPending}
          // The default is the form layer's "Saving…", which is wrong here:
          // nothing is being saved, a number is being registered with Meta.
          pendingLabel={copy.action}
        >
          {copy.action}
        </Button>
      </div>
    </Stack>
  );
}
