import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ChatbotPipelineSectionSkeleton } from '@/features/chatbot/components/ChatbotPipelineSection';
import { ChatbotSettingsFormSkeleton } from '@/features/chatbot/components/ChatbotSettingsForm.Skeleton';
import { KnowledgeBaseSectionSkeleton } from '@/features/chatbot/components/KnowledgeBaseSection';

/**
 * The route-level skeleton. Composed from the page's own section skeletons, in
 * the page's own order — pipeline, sources, then the three settings cards — so
 * arriving here does not reflow when the real page lands.
 *
 * The sources card draws its unfiltered placeholder: `loading.tsx` receives no
 * `searchParams`, and the filtered row count is the page's to decide once it has
 * read them.
 */
export default function ChatbotSettingsLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.chatbot.title} subtitle={content.chatbot.subtitle} />
      <ChatbotPipelineSectionSkeleton />
      <KnowledgeBaseSectionSkeleton />
      <ChatbotSettingsFormSkeleton />
    </Stack>
  );
}
