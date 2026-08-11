'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/ToastProvider';
import { useContent } from '@/lib/content';
import { useServiceWindow } from '@/features/inbox/useServiceWindow';
import type { ServiceWindow } from '@/features/inbox/service-window';
import { FreeFormComposer, FreeFormComposerSkeleton } from './FreeFormComposer';
import { ServiceWindowBanner, ServiceWindowBannerSkeleton } from './ServiceWindowBanner';
import { LazyTemplatePickerDialog } from './inbox-dialogs.lazy';
import styles from './MessageComposer.module.css';

/**
 * The reply box: what an agent may send to this customer, and which of the two
 * ways WhatsApp allows it. Usage, at the foot of the thread card:
 *
 * ```tsx
 * <MessageComposer
 *   conversationId={conversation.id}
 *   serviceWindowExpiresAt={conversation.serviceWindowExpiresAt}
 *   initialWindow={serviceWindowAt(conversation.serviceWindowExpiresAt, new Date())}
 *   canSend={session.checker.can('conversation:send')}
 * />
 * ```
 *
 * ## The two modes are one component
 *
 * Inside Meta's 24-hour service window an agent writes what they like. Outside
 * it, WhatsApp accepts only a template the business had approved in advance —
 * so the free-form control is disabled rather than removed (the draft survives,
 * and the reason is on screen) and the template picker becomes the way through.
 *
 * A template may be sent in either state; it is simply the only option in one of
 * them. Two components would have meant two Send buttons, two error paths and
 * two idempotency keys for one act.
 *
 * ## Why the window is a prop *and* a hook
 *
 * `initialWindow` is computed on the server so the first client render matches
 * the markup that arrived; `useServiceWindow` then owns it and flips at the
 * moment the window shuts. Deciding it during render from `Date.now()` would be
 * a hydration mismatch, and deciding it only on the server would leave an agent
 * typing into a composer that stopped working ten minutes ago.
 */

export interface MessageComposerProps {
  conversationId: string;
  /** `conversations.service_window_expires_at`; `null` means closed, not unknown. */
  serviceWindowExpiresAt: string | null;
  /** Evaluated on the server, so the first client render agrees with it. */
  initialWindow: ServiceWindow;
  /** `conversation:send`. Every role above guest has it; a reader may not. */
  canSend: boolean;
}

export function MessageComposer({
  conversationId,
  serviceWindowExpiresAt,
  initialWindow,
  canSend,
}: MessageComposerProps) {
  const content = useContent();
  const window = useServiceWindow(serviceWindowExpiresAt, initialWindow);
  const [isPickingTemplate, setIsPickingTemplate] = useState(false);

  useWindowClosedNotice(window);

  if (!canSend) {
    // Said rather than left as a missing box, for the reason the claim button
    // gives: a console that showed nothing here would read as a broken screen.
    return <Notice tone="info">{content.composer.sendNotPermitted}</Notice>;
  }

  return (
    <Stack gap="3" className={styles.composer}>
      <ServiceWindowBanner window={window} />

      <FreeFormComposer conversationId={conversationId} isWindowOpen={window.state === 'open'} />

      <Cluster justify="start" gap="2">
        <Button
          variant={window.state === 'open' ? 'ghost' : 'primary'}
          onClick={() => {
            setIsPickingTemplate(true);
          }}
        >
          {content.composer.useTemplate}
        </Button>
      </Cluster>

      {isPickingTemplate ? (
        <LazyTemplatePickerDialog
          conversationId={conversationId}
          onClose={() => {
            setIsPickingTemplate(false);
          }}
        />
      ) : null}
    </Stack>
  );
}

/**
 * Mirrors `MessageComposer`: the same seam above it, and each of its three parts
 * standing in for itself — so the swap moves nothing under the cursor of an
 * agent already reaching for the box.
 *
 * No `LoadingAnnouncement`: the thread above already announces itself once, and
 * a region announcing its own sub-parts is how a screen reader ends up reading
 * the same loading state twice.
 */
export function MessageComposerSkeleton() {
  return (
    <Stack gap="3" className={styles.composer} aria-hidden="true">
      <ServiceWindowBannerSkeleton />
      <FreeFormComposerSkeleton />
      <Cluster justify="start">
        <SkeletonLine width="8.5rem" height="var(--size-touch-target)" />
      </Cluster>
    </Stack>
  );
}

/**
 * Announces the window shutting, once, at the moment it happens.
 *
 * The banner above changes on its own, but an agent part-way through a reply is
 * looking at the textarea, not at the notice over it — and the next thing they
 * would otherwise learn is that Send does not work. The toast is the
 * interruption that earns its place: it reports a change nobody asked for, on a
 * conversation they are actively working.
 *
 * It fires on the open → closed edge only. A thread that was already closed when
 * it was opened is not news.
 */
function useWindowClosedNotice(window: ServiceWindow): void {
  const content = useContent();
  const { showToast } = useToast();
  const wasOpen = useRef(window.state === 'open');

  useEffect(() => {
    if (wasOpen.current && window.state === 'closed') {
      showToast({ tone: 'info', message: content.composer.windowJustClosedToast });
    }

    wasOpen.current = window.state === 'open';
  }, [window.state, showToast, content.composer.windowJustClosedToast]);
}
