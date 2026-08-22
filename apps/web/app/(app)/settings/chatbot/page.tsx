import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requireAnyPermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  ChatbotSections,
  ChatbotSectionsSkeleton,
  CHATBOT_PERMISSIONS,
} from '@/features/chatbot/components/ChatbotSections';

/**
 * The AI chatbot settings surface (TAR-28): whether it is answering, the
 * settings that decide when it does, and the knowledge base it answers from.
 * Composition only — gate, header, and the section group behind its own error
 * and Suspense boundaries.
 *
 * Gated on either permission rather than on `ai:write`, so a principal who may
 * read the configuration gets a read-only surface instead of a 403.
 * `settingsNavItems` hides the entry on the same rule. Both are UX; the API
 * enforces each endpoint independently.
 */

export const metadata: Metadata = {
  title: `${content.chatbot.title} · ${content.app.name}`,
  description: content.chatbot.subtitle,
};

/** Resolves a live session and live readiness; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

const CHATBOT_SETTINGS_PERMISSIONS = [CHATBOT_PERMISSIONS.read, CHATBOT_PERMISSIONS.write] as const;

export default async function ChatbotSettingsPage() {
  const session = await requireAnyPermission(CHATBOT_SETTINGS_PERMISSIONS);

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.chatbot.title} subtitle={content.chatbot.subtitle} />
      <SectionErrorBoundary>
        <Suspense fallback={<ChatbotSectionsSkeleton />}>
          <ChatbotSections checker={session.checker} />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
