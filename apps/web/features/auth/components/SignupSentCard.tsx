'use client';

import { useCallback, useState } from 'react';
import {
  LIFECYCLE_POLICY,
  SIGNUP_POLICY,
  type SignupAcceptedResponse,
} from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { AuthCard } from './AuthCard';
import { resendVerification } from '../signup.requests';
import { useFocusOnMount } from '../useFocusOnMount';
import styles from './SignupSentCard.module.css';

/**
 * What replaces the signup form once the link is in the post. Usage:
 * `<SignupSentCard accepted={accepted} onUseAnotherAddress={…} />`.
 *
 * Close to `AuthOutcomeCard` and deliberately not built on it: every other
 * outcome card in this folder is a dead end whose only job is to point at the
 * next screen, and this one holds an **action that can fail in place**. A card
 * that can show a failure needs a region for it, a pending state on the control,
 * and a count of how many times it has been pressed — none of which an outcome
 * card has anywhere to put.
 *
 * It takes focus on mount for the reason `AuthOutcomeCard` does: the form the
 * user just submitted has unmounted, and focus would otherwise fall to `<body>`
 * with nothing announced.
 *
 * ## The address is named and nothing about it is confirmed
 *
 * `POST /signup` answers the same `202` for a new signup, a repeat, and an
 * address that already runs a workspace — otherwise the form would be a way to
 * ask "does this person use the product". So this card says what was *sent*, and
 * never what was *found*.
 *
 * ## Why the resend button has a ceiling
 *
 * `SIGNUP_POLICY.resendsPerSignup` is counted on the pending row itself, so the
 * console can stop at the same number rather than offering a press whose only
 * possible answer is a refusal. Past it the message changes to say what is
 * actually wrong — the address is not receiving our mail — because a fourth copy
 * is not what fixes that.
 */
export function SignupSentCard({
  accepted,
  onUseAnotherAddress,
}: {
  accepted: SignupAcceptedResponse;
  onUseAnotherAddress: () => void;
}) {
  const content = useContent();
  const headingRef = useFocusOnMount<HTMLHeadingElement>();
  const [sendCount, setSendCount] = useState(0);
  const [hasJustResent, setHasJustResent] = useState(false);

  const perform = useCallback(async () => {
    return resendVerification(accepted.email);
  }, [accepted.email]);

  const onSuccess = useCallback(() => {
    setSendCount((current) => current + 1);
    setHasJustResent(true);
  }, []);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  const isExhausted = sendCount >= SIGNUP_POLICY.resendsPerSignup;

  return (
    <AuthCard icon="mail" title={content.auth.signupSentHeading} headingRef={headingRef}>
      <Stack gap="4">
        <p>{content.auth.signupSentBody(accepted.email)}</p>
        <p className={styles.detail}>{content.auth.signupSentExpiry(VERIFY_LINK_TTL_HOURS)}</p>

        <FormError message={formError} requestId={requestId} />

        {/*
          One line at a time. The confirmation replaces the hint rather than
          stacking under it: "check your spam folder" and "a new link is on its
          way" are the same advice at two moments, and showing both makes the
          card look like it is arguing with itself.
        */}
        {isExhausted ? (
          <Notice tone="warning">{content.auth.signupResendExhausted}</Notice>
        ) : hasJustResent ? (
          <Notice tone="info">{content.auth.signupResendSent}</Notice>
        ) : (
          <Notice tone="info">{content.auth.signupSentHint}</Notice>
        )}

        <div className={styles.actions}>
          {isExhausted ? null : (
            <Button
              variant="primary"
              isBlock
              isPending={isPending}
              pendingLabel={content.auth.signupResendPending}
              onClick={() => {
                // Cleared before the request rather than after it, so a second
                // press does not leave the previous confirmation on screen
                // describing a send that is no longer the latest one.
                setHasJustResent(false);
                submit();
              }}
            >
              {content.auth.signupResend}
            </Button>
          )}
          <Button
            variant={isExhausted ? 'primary' : 'secondary'}
            isBlock
            disabled={isPending}
            onClick={onUseAnotherAddress}
          >
            {content.auth.signupUseAnotherAddress}
          </Button>
        </div>
      </Stack>
    </AuthCard>
  );
}

/**
 * Derived from the contract rather than written down, so the copy cannot promise
 * a window the API does not honour — the rule `ForgotPasswordForm` follows for
 * the reset link's own lifetime.
 */
const MS_PER_HOUR = 60 * 60 * 1000;
const VERIFY_LINK_TTL_HOURS = LIFECYCLE_POLICY.signupTokenTtlMs / MS_PER_HOUR;
