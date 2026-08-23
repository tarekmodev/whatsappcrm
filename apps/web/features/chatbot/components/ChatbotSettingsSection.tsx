import { LazyBoundary } from '@/components/ui/LazyBoundary';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadChatbotConfig } from '../chatbot.data';
import { CHATBOT_PERMISSIONS } from '../constants';
import { ChatbotSettingsFormSkeleton } from './ChatbotSettingsForm.Skeleton';
import { LazyChatbotSettingsForm } from './chatbot-widgets.lazy';

/**
 * Reads the configuration and decides who may change it, then hands both to the
 * form. Usage: inside an **unkeyed** Suspense boundary on the chatbot page, with
 * `ChatbotSettingsFormSkeleton` as the fallback.
 *
 * A server component, so the permission decision and the read happen on the
 * server and the client bundle carries neither.
 *
 * **Unkeyed is load-bearing** (TAR-613). The sources card above is filtered from
 * the URL and its boundary is keyed on those filters, so it remounts on every
 * debounced keystroke. This boundary must not: React reconciles it in place
 * instead, which is what stops a search in the sources table throwing away an
 * admin's half-written system prompt.
 *
 * The plan's own refusal is rendered as an upsell inside the form rather than as
 * a 403: `GET /ai/config` is readable without the `ai_chatbot` feature precisely
 * so this page can explain itself to a tenant that has not bought it.
 */
export async function ChatbotSettingsSection({ checker }: { checker: PermissionChecker }) {
  const config = await loadChatbotConfig();
  // Two gates, not one: `ai:write` is what the endpoints require, and the plan
  // feature is what the API checks on top of it. A principal who holds the
  // permission on a plan without the chatbot still gets a read-only surface,
  // because the alternative is a form that submits into a refusal.
  const isInPlan = !config.readiness.blockers.includes('feature_not_in_plan');
  const canWrite = checker.can(CHATBOT_PERMISSIONS.write) && isInPlan;

  return (
    <LazyBoundary fallback={<ChatbotSettingsFormSkeleton />}>
      <LazyChatbotSettingsForm config={config} canWrite={canWrite} isInPlan={isInPlan} />
    </LazyBoundary>
  );
}
