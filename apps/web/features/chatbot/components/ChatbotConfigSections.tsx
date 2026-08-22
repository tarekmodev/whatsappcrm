import { Stack } from '@/components/layout/Stack';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadChatbotConfig } from '../chatbot.data';
import { CHATBOT_PERMISSIONS } from '../constants';
import { AiConfigFormSkeleton } from './AiConfigForm.Skeleton';
import { BotReadinessPanel, BotReadinessPanelSkeleton } from './BotReadinessPanel';
import { LazyAiConfigForm } from './chatbot-widgets.lazy';

/**
 * Fetches the chatbot's configuration and composes the two cards that are made
 * of it: whether it is answering, and the settings that decide when. Usage:
 * inside an **unkeyed** Suspense boundary on the chatbot settings page, with
 * `ChatbotConfigSectionsSkeleton` as the fallback.
 *
 * A server component, so the permission decision and the read happen on the
 * server and the client bundle carries neither.
 *
 * **Unkeyed is load-bearing** (TAR-613). The knowledge base below is filtered
 * from the URL and its boundary is keyed on those filters, so it remounts on
 * every debounced keystroke. This boundary must not: React reconciles it in
 * place instead, which is what stops a search in the table below throwing away
 * an admin's half-written system prompt.
 *
 * **Readiness comes first, and it is not part of the form.** The single most
 * important fact on this page is whether customers are getting automated replies
 * right now, and a switch labelled "on" says nothing about whether there is
 * anything to answer from. Putting the answer above the controls is what makes
 * TAR-28's third acceptance criterion visible rather than inferable.
 *
 * The plan's own refusal is rendered as an upsell rather than a 403: `GET
 * /ai/config` is readable without the `ai_chatbot` feature precisely so this page
 * can explain itself to a tenant that has not bought it.
 */
export async function ChatbotConfigSections({ checker }: { checker: PermissionChecker }) {
  const config = await loadChatbotConfig();
  // Two gates, not one: `ai:write` is what the endpoints require, and the plan
  // feature is what the API checks on top of it. A principal who holds the
  // permission on a plan without the chatbot still gets a read-only surface,
  // because the alternative is a form that submits into a refusal.
  const isInPlan = !config.readiness.blockers.includes('feature_not_in_plan');
  const canWrite = checker.can(CHATBOT_PERMISSIONS.write) && isInPlan;

  return (
    <Stack gap="5">
      <SectionCard
        id="chatbot-readiness"
        title={content.chatbot.readinessHeading}
        description={content.chatbot.readinessDescription}
      >
        <BotReadinessPanel readiness={config.readiness} />
      </SectionCard>

      <SectionCard
        id="chatbot-settings"
        title={content.chatbot.settingsHeading}
        description={content.chatbot.settingsDescription}
      >
        <Stack gap="4">
          {isInPlan ? null : <Notice tone="warning">{content.chatbot.upsellNotice}</Notice>}
          <LazyBoundary fallback={<AiConfigFormSkeleton />}>
            <LazyAiConfigForm config={config} canWrite={canWrite} />
          </LazyBoundary>
        </Stack>
      </SectionCard>
    </Stack>
  );
}

/**
 * The fallback. The same stack and gap and the same two cards, each holding its
 * own section's skeleton, so the page does not reflow when the data lands.
 *
 * The upsell notice is not drawn: whether it appears depends on the plan, which
 * has not arrived, and reserving space for it would leave a gap on the common
 * path where there is nothing to say. A notice that pushes the form down when it
 * appears is correct — it is the page telling somebody something they need to
 * read.
 *
 * Changed in the same commit as the sections it stands in for.
 */
export function ChatbotConfigSectionsSkeleton() {
  return (
    <Stack gap="5">
      <SectionCard
        id="chatbot-readiness"
        title={content.chatbot.readinessHeading}
        description={content.chatbot.readinessDescription}
      >
        <BotReadinessPanelSkeleton />
      </SectionCard>
      <SectionCard
        id="chatbot-settings"
        title={content.chatbot.settingsHeading}
        description={content.chatbot.settingsDescription}
      >
        <AiConfigFormSkeleton />
      </SectionCard>
    </Stack>
  );
}
