'use client';

import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { Field } from '@/components/ui/Field';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonBlock, SkeletonForText } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import styles from './AiConfigForm.module.css';

/**
 * Mirrors `AiConfigForm` — the same wrapper and measure cap, the same seven
 * `Field`s with the same labels and hints in the same order, and the same
 * right-aligned action row — so the lazy boundary hands over without the card
 * changing height.
 *
 * The labels and hints are real strings, because they are copy the skeleton
 * already knows; only the values and the button are placeholders. Each control
 * is a `SkeletonBlock` at the height its real control occupies — one control
 * height for the inputs and the switch row, four rows for each textarea — which
 * is what makes the swap produce no shift.
 *
 * `'use client'`, and it has to be: it renders through the real `Field`, whose
 * render-prop children are a function, and a function cannot cross the
 * server-to-client boundary. The same trade `WorkspaceProfileForm.Skeleton`
 * makes, for the same reason — rendering the real `Field` is what stops this
 * drifting when its spacing changes.
 *
 * Changed in the same commit as the form it stands in for.
 */
export function AiConfigFormSkeleton() {
  const content = useContent();

  return (
    <div className={styles.form}>
      <Stack gap="4">
        <LoadingAnnouncement label={content.chatbot.loading} />

        <Field label={content.chatbot.enabledLabel} hint={content.chatbot.enabledHint}>
          {() => <SkeletonBlock height="var(--size-icon-md)" />}
        </Field>
        <Field label={content.chatbot.modelLabel} hint={content.chatbot.modelHint}>
          {() => <SkeletonBlock height="var(--size-control-md)" />}
        </Field>
        <Field label={content.chatbot.confidenceLabel} hint={content.chatbot.confidenceHint}>
          {() => <SkeletonBlock height="var(--size-touch-target)" />}
        </Field>
        <Field label={content.chatbot.maxTurnsLabel} hint={content.chatbot.maxTurnsHint}>
          {() => <SkeletonBlock height="var(--size-control-md)" />}
        </Field>
        <Field
          label={content.chatbot.handoffKeywordsLabel}
          hint={content.chatbot.handoffKeywordsHint}
        >
          {() => <SkeletonBlock height="var(--space-8)" />}
        </Field>
        <Field label={content.chatbot.systemPromptLabel} hint={content.chatbot.systemPromptHint}>
          {() => <SkeletonBlock height="var(--space-8)" />}
        </Field>
        <Field
          label={content.chatbot.handoffMessageLabel}
          hint={content.chatbot.handoffMessageHint}
        >
          {() => <SkeletonBlock height="var(--size-control-md)" />}
        </Field>

        <Cluster justify="end">
          <span aria-hidden="true" className={styles.actionPlaceholder}>
            <SkeletonForText>{content.chatbot.saveSettings}</SkeletonForText>
          </span>
        </Cluster>
      </Stack>
    </div>
  );
}
