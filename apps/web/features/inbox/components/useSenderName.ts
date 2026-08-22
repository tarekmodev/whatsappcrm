'use client';

import { useCallback } from 'react';
import { useContent } from '@/lib/content';
import type { MessageSender } from '@/features/inbox/message-runs';

/**
 * Turns a `MessageSender` into the name the thread shows for it. Usage:
 *
 * ```tsx
 * const senderName = useSenderName();
 * senderName(run.sender, contactName, senderNames);
 * ```
 *
 * A hook rather than a pure function because the copy for the three non-human
 * senders comes from the content layer. Shared because two things say the name —
 * the run's label line, and the polite region that announces an arriving message
 * — and a thread whose label and announcement disagree about who spoke is worse
 * than one that says less.
 *
 * The directory behind `sentByUserId` is one page of users, so a large tenant has
 * agents beyond it. An unresolved id falls back to "a teammate", never to
 * "automation": attributing a colleague's words to a machine is a lie about the
 * one thing this product is a record of.
 */
export function useSenderName(): (
  sender: MessageSender,
  contactName: string,
  senderNames: ReadonlyMap<string, string>,
) => string {
  const content = useContent();

  return useCallback(
    (sender, contactName, senderNames) => {
      switch (sender.kind) {
        case 'contact':
          return contactName;
        case 'bot':
          return content.thread.senderBot;
        case 'automation':
          return content.thread.senderAutomation;
        case 'agent':
          return senderNames.get(sender.userId) ?? content.thread.senderTeammate;
        case 'teammate':
          return content.thread.senderTeammate;
      }
    },
    [content],
  );
}
