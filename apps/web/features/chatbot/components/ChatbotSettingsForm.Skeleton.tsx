'use client';

import { Field } from '@/components/ui/Field';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SectionCard } from '@/components/ui/SectionCard';
import { SettingsForm, SettingsFormSection } from '@/components/ui/SettingsForm';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { CHATBOT_SECTION_IDS } from '../constants';

/**
 * The fallback for the three settings cards.
 *
 * The same three cards with the same headings and the same fields, so the swap
 * to the real form moves nothing — and so the rail above can still link into
 * them: a fragment target that only exists once a lazy chunk has loaded is a
 * link that does nothing on the slow connection it was most needed on.
 *
 * No save bar. Whether one appears depends on somebody having changed something,
 * which cannot have happened yet.
 *
 * Changed in the same commit as the form it stands in for.
 */
export function ChatbotSettingsFormSkeleton() {
  const content = useContent();

  return (
    <SettingsForm as="div">
      <LoadingAnnouncement label={content.chatbot.loading} />

      <SectionCard
        id={CHATBOT_SECTION_IDS.eligibility}
        title={content.chatbot.eligibilityHeading}
        description={content.chatbot.eligibilityDescription}
      >
        <SettingsFormSection>
          <Field label={content.chatbot.ruleEnabledName} hint={content.chatbot.ruleEnabledClause}>
            {() => <SkeletonBlock height="var(--size-touch-target)" />}
          </Field>
          <Field label={content.chatbot.ruleThreadName} hint={content.chatbot.ruleThreadClause}>
            {() => <SkeletonBlock height="var(--size-control-md)" />}
          </Field>
          <Field label={content.chatbot.ruleTurnsName} hint={content.chatbot.ruleTurnsClauseUnset}>
            {() => <SkeletonBlock height="var(--size-control-md)" />}
          </Field>
          <Field
            label={content.chatbot.ruleKeywordsName}
            hint={content.chatbot.handoffKeywordsHint}
          >
            {() => <SkeletonBlock height="var(--space-8)" />}
          </Field>
        </SettingsFormSection>
      </SectionCard>

      <SectionCard
        id={CHATBOT_SECTION_IDS.confidence}
        title={content.chatbot.confidenceHeading}
        description={content.chatbot.confidenceDescription}
      >
        <Field label={content.chatbot.confidenceLabel} hint={content.chatbot.confidenceHint}>
          {() => <SkeletonBlock height="var(--size-control-md)" />}
        </Field>
      </SectionCard>

      <SectionCard
        id={CHATBOT_SECTION_IDS.handoff}
        title={content.chatbot.handoffHeading}
        description={content.chatbot.handoffDescription}
      >
        <SettingsFormSection>
          <Field label={content.chatbot.modelLabel} hint={content.chatbot.modelHint}>
            {() => <SkeletonBlock height="var(--size-control-md)" />}
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
        </SettingsFormSection>
      </SectionCard>
    </SettingsForm>
  );
}
