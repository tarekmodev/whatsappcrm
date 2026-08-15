'use client';

import { useState } from 'react';
import type { KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { KNOWLEDGE_DOCUMENTS_PAGE_SIZE } from '../constants';
import {
  KnowledgeDocumentsTable,
  KnowledgeDocumentsTableSkeleton,
} from './KnowledgeDocumentsTable';
import { LazyKnowledgeEntryDialog } from './knowledge-dialogs.lazy';

/**
 * The knowledge base section: the card, the add trigger and the table. Usage:
 * `<KnowledgeBaseSection documents={documents} hasMore canWrite />`.
 *
 * `canWrite` comes from the server's permission check, so a principal holding
 * only `ai:read` is never rendered a control that leads to a refusal.
 *
 * The "more entries than fit" line is a notice rather than a pager. The list is
 * keyset-paginated and a second page is a real feature; until it exists, saying
 * how many are shown is honest, and a pager that could not page would not be.
 */
export function KnowledgeBaseSection({
  documents,
  hasMore,
  canWrite,
}: {
  documents: readonly KnowledgeDocumentResponse[];
  hasMore: boolean;
  canWrite: boolean;
}) {
  const content = useContent();
  const [isAdding, setIsAdding] = useState(false);

  return (
    <SectionCard
      id="knowledge-base"
      title={content.chatbot.knowledgeHeading}
      description={content.chatbot.knowledgeDescription}
      action={
        canWrite ? (
          <Button
            variant="primary"
            onClick={() => {
              setIsAdding(true);
            }}
          >
            {content.chatbot.addEntry}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="4">
        {hasMore ? (
          <Notice tone="info">
            {content.chatbot.knowledgeShowingFirst(KNOWLEDGE_DOCUMENTS_PAGE_SIZE)}
          </Notice>
        ) : null}

        <KnowledgeDocumentsTable documents={documents} canWrite={canWrite} />
      </Stack>

      {isAdding ? (
        <LazyKnowledgeEntryDialog
          onClose={() => {
            setIsAdding(false);
          }}
        />
      ) : null}
    </SectionCard>
  );
}

/** Mirrors the section's frame, with the table's own skeleton inside it. */
export function KnowledgeBaseSectionSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <SectionCard
      id="knowledge-base"
      title={content.chatbot.knowledgeHeading}
      description={content.chatbot.knowledgeDescription}
    >
      <KnowledgeDocumentsTableSkeleton hasActions={hasActions} />
    </SectionCard>
  );
}
