'use client';

import { useCallback } from 'react';
import type { OnboardingStepId, OnboardingStepIntent } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { useToast } from '@/components/ui/ToastProvider';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { setOnboardingStepIntentAction } from '../onboarding.actions';

/**
 * Skips a step, or puts a skipped one back. Usage:
 * `<OnboardingStepIntentButton stepId="set_branding" intent="skip" stepTitle={…} />`.
 *
 * The only client component in the checklist. Everything else — which step is
 * open, what each one says, how far along the tenant is — is server-rendered from
 * the URL and the API, so this island carries one button and its failure message
 * rather than the whole walkthrough.
 *
 * Deliberately **not** optimistic. The action revalidates the route and the
 * server re-renders the list, the meter and the open step together; an optimistic
 * tick here would have to roll back three of those on failure, and the write it
 * stands for takes one round trip.
 */
export function OnboardingStepIntentButton({
  stepId,
  intent,
  stepTitle,
}: {
  stepId: OnboardingStepId;
  intent: OnboardingStepIntent;
  /** Named in the toast, so "skipped" says *what* was skipped. */
  stepTitle: string;
}) {
  const content = useContent();
  const { showToast } = useToast();

  const onSuccess = useCallback(() => {
    showToast({
      tone: 'info',
      message:
        intent === 'skip'
          ? content.onboarding.skippedToast(stepTitle)
          : content.onboarding.unskippedToast(stepTitle),
    });
  }, [content, intent, showToast, stepTitle]);

  const perform = useCallback(
    () => setOnboardingStepIntentAction({ stepId, intent }),
    [intent, stepId],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <Stack gap="2">
      {/* Above the control, and never only in the toast: a toast the user has
          already dismissed is not where a failure lives. */}
      <FormError message={formError} requestId={requestId} />
      <Button
        variant="ghost"
        isPending={isPending}
        onClick={() => {
          submit();
        }}
      >
        {intent === 'skip' ? content.onboarding.skip : content.onboarding.unskip}
      </Button>
    </Stack>
  );
}
