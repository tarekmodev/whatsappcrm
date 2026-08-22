import type { PermissionChecker } from '@/lib/session/permissions';
import { loadChatbotConfig } from '../chatbot.data';
import { CHATBOT_PERMISSIONS } from '../constants';
import { AddKnowledgeEntryButton } from './AddKnowledgeEntryButton';

/**
 * Resolves the plan gate for the knowledge base card's action slot. Usage:
 * inside its own Suspense boundary in `KnowledgeBaseSection`, with a
 * button-sized `SkeletonBlock` as the fallback.
 *
 * Its own async component so the card's *frame* awaits nothing (TAR-613). The
 * frame holds the filter bar and the table's keyed boundary, and if it had to
 * resolve `GET /ai/config` before rendering, every filter change would wait on
 * the configuration before the table skeleton could even paint. Here, the
 * `action` and `children` subtrees are created in the same synchronous render
 * pass, so the config read and the documents read stay concurrent — the
 * parallelism the old single `Promise.all` had.
 *
 * Two gates, not one: `ai:write` is what the endpoints require, and the plan
 * feature is what the API checks on top of it. A principal holding the
 * permission on a plan without the chatbot gets a read-only surface, because the
 * alternative is a dialog that submits into a refusal.
 */
export async function AddKnowledgeEntryAction({ checker }: { checker: PermissionChecker }) {
  const config = await loadChatbotConfig();
  const isInPlan = !config.readiness.blockers.includes('feature_not_in_plan');

  return checker.can(CHATBOT_PERMISSIONS.write) && isInPlan ? <AddKnowledgeEntryButton /> : null;
}
