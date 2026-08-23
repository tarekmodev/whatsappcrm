'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useContent } from '@/lib/content';
import { LazyKnowledgeEntryDialog } from './knowledge-dialogs.lazy';

/**
 * The knowledge base card's `Add entry` action, and the editor it opens. Usage:
 * `<AddKnowledgeEntryButton />`, from the server component that decided the
 * principal may write.
 *
 * The one client leaf of the card's header. It used to be state on
 * `KnowledgeBaseSection`, which forced the whole frame — the card, the filter
 * row and the table's boundary — into the client bundle; splitting it out is
 * what lets the frame be a server component and the filter bar sit outside the
 * keyed boundary (TAR-613).
 *
 * It renders nothing about permissions: whether this button exists at all is
 * `AddKnowledgeEntryAction`'s decision, made on the server, so a principal who
 * cannot write is never rendered a control that leads to a refusal.
 */
export function AddKnowledgeEntryButton() {
  const content = useContent();
  const [isAdding, setIsAdding] = useState(false);

  return (
    <>
      <Button
        variant="primary"
        onClick={() => {
          setIsAdding(true);
        }}
      >
        {content.chatbot.addEntry}
      </Button>

      {/* The editor chunk loads on first open, not with the page. */}
      {isAdding ? (
        <LazyKnowledgeEntryDialog
          onClose={() => {
            setIsAdding(false);
          }}
        />
      ) : null}
    </>
  );
}
