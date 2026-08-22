'use client';

import { Field } from '@/components/ui/Field';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import {
  SettingsForm,
  SettingsFormActions,
  SettingsFormSection,
} from '@/components/ui/SettingsForm';
import { SkeletonBlock, SkeletonForText } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import styles from './AiConfigForm.module.css';

/**
 * Mirrors `AiConfigForm` — the same `SettingsForm`, the same two sections with
 * the same hairline between them, the same seven `Field`s with the same labels
 * and hints in the same order, and the same trailing action row — so the lazy
 * boundary hands over without the card changing height, at either layout.
 *
 * The labels and hints are real strings, because they are copy the skeleton
 * already knows; only the values and the button are placeholders. Each control
 * is a `SkeletonBlock` at the height its real control occupies — a touch target
 * for the switch and the slider, a control height for the inputs, four rows for
 * each textarea — which is what makes the swap produce no shift.
 *
 * `'use client'`, and it has to be: it renders through the real `Field` and the
 * real `SettingsForm`, whose render-prop children are a function, and a function
 * cannot cross the server-to-client boundary. The same trade
 * `WorkspaceProfileForm.Skeleton` makes, for the same reason — rendering the real
 * layout is what stops this drifting when its spacing changes.
 *
 * Changed in the same commit as the form it stands in for.
 */
export function AiConfigFormSkeleton() {
  const content = useContent();

  return (
    <SettingsForm as="div">
      <LoadingAnnouncement label={content.chatbot.loading} />

      <SettingsFormSection>
        <Field label={content.chatbot.enabledLabel} hint={content.chatbot.enabledHint}>
          {() => <SkeletonBlock height="var(--size-touch-target)" />}
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
      </SettingsFormSection>

      <SettingsFormSection>
        <Field label={content.chatbot.systemPromptLabel} hint={content.chatbot.systemPromptHint}>
          {() => <SkeletonBlock height="var(--space-8)" />}
        </Field>
        <Field
          label={content.chatbot.handoffMessageLabel}
          hint={content.chatbot.handoffMessageHint}
        >
          {() => <SkeletonBlock height="var(--size-control-md)" />}
        </Field>
      </SettingsFormSection>

      <SettingsFormActions>
        <span aria-hidden="true" className={styles.actionPlaceholder}>
          <SkeletonForText>{content.chatbot.saveSettings}</SkeletonForText>
        </span>
      </SettingsFormActions>
    </SettingsForm>
  );
}
