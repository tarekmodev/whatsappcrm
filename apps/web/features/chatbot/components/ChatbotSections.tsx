import type { Permission } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadChatbot } from '../chatbot.data';
import { AiConfigFormSkeleton } from './AiConfigForm.Skeleton';
import { BotReadinessPanel, BotReadinessPanelSkeleton } from './BotReadinessPanel';
import { KnowledgeBaseSection, KnowledgeBaseSectionSkeleton } from './KnowledgeBaseSection';
import { LazyAiConfigForm } from './chatbot-widgets.lazy';

/**
 * Fetches the chatbot's configuration and knowledge base, then composes the
 * page's three sections. Usage: inside a Suspense boundary on the chatbot
 * settings page, with `ChatbotSectionsSkeleton` as the fallback.
 *
 * A server component, so the permission decision and both reads happen on the
 * server and the client bundle carries neither.
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

/** The permissions this surface's controls are gated on, named once. */
export const CHATBOT_PERMISSIONS = {
  read: 'ai:read',
  write: 'ai:write',
} as const satisfies Record<string, Permission>;

export async function ChatbotSections({ checker }: { checker: PermissionChecker }) {
  const { config, documents, hasMoreDocuments } = await loadChatbot();
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

      <KnowledgeBaseSection
        documents={documents}
        hasMore={hasMoreDocuments}
        // From the same read as the readiness panel above, so "the only entry
        // the chatbot can answer from" and "it answers from N entries" are one
        // number rather than two that can disagree.
        indexedEntryCount={config.readiness.indexedDocumentCount}
        canWrite={canWrite}
      />
    </Stack>
  );
}

/**
 * The fallback. The same stack and gap and the same three cards, each holding
 * its own section's skeleton, so the page does not reflow when the data lands.
 *
 * The upsell notice is not drawn: whether it appears depends on the plan, which
 * has not arrived, and reserving space for it would leave a gap on the common
 * path where there is nothing to say. A notice that pushes the form down when it
 * appears is correct — it is the page telling somebody something they need to
 * read.
 *
 * Row actions are assumed present in the table skeleton for the same reason the
 * workspace skeleton always draws its plan card: this route's `loading.tsx` has
 * no session to read, and every principal who reaches this page under today's
 * role table holds `ai:write`.
 *
 * Changed in the same commit as the sections it stands in for.
 */
export function ChatbotSectionsSkeleton() {
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
      <KnowledgeBaseSectionSkeleton />
    </Stack>
  );
}
