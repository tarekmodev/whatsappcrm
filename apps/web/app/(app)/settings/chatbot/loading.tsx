import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ChatbotConfigSectionsSkeleton } from '@/features/chatbot/components/ChatbotConfigSections';
import { KnowledgeBaseSectionSkeleton } from '@/features/chatbot/components/KnowledgeBaseSection';

/**
 * The route-level skeleton. Composed from the page's own section skeletons in
 * the same stack, with the same header, so arriving here does not reflow when
 * the real page lands.
 *
 * The knowledge base draws its unfiltered placeholder: `loading.tsx` receives no
 * `searchParams`, and the filtered row count is the page's to decide once it has
 * read them.
 */
export default function ChatbotSettingsLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.chatbot.title} subtitle={content.chatbot.subtitle} />
      <ChatbotConfigSectionsSkeleton />
      <KnowledgeBaseSectionSkeleton />
    </Stack>
  );
}
