'use client';

import { useEffect, useRef, useState } from 'react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useContent } from '@/lib/content';
import { useServiceWindow } from '@/features/inbox/useServiceWindow';
import type { ServiceWindow } from '@/features/inbox/service-window';
import type { ComposerGuidance } from '@/features/inbox/thread-state';
import { FreeFormComposer, FreeFormComposerSkeleton } from './FreeFormComposer';
import { ServiceWindowHint } from './ServiceWindowHint';
import { LazyTemplatePickerDialog } from './inbox-dialogs.lazy';
import styles from './MessageComposer.module.css';

/**
 * The reply box: what an agent may send to this customer, and which of the two
 * ways WhatsApp allows it. Usage, in the composer dock at the foot of the thread:
 *
 * ```tsx
 * <MessageComposer
 *   conversationId={conversation.id}
 *   serviceWindowExpiresAt={conversation.serviceWindowExpiresAt}
 *   initialWindow={serviceWindowAt(conversation.serviceWindowExpiresAt, new Date())}
 *   guidance={state.guidance}
 *   canWrite={state.canWrite}
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
 * ## One guidance line, and it is quiet
 *
 * Why the box is shut — or why nobody has replied although it is open — is
 * `thread-state.ts`'s single answer, rendered here as one quiet line. It used to
 * be up to two full-width saturated notices, one of them above the message
 * stream, saying overlapping things about the same conversation (TAR-518). It is
 * sited here because this is where the reply was going to be typed.
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
  /**
   * The one line explaining the thread's state, or `null` when there is nothing
   * to explain. Decided by `threadState` so the header and this cannot disagree.
   */
  guidance: ComposerGuidance | null;
  /**
   * Whether the controls are usable at all. `false` for a role without
   * `conversation:send`, and for a thread nobody holds — the API refuses every
   * write into the shared pool (TAR-186), and an agent typing a reply that can
   * only end in a 409 is worse than no composer at all.
   */
  canWrite: boolean;
  /**
   * The tenant's canned-response library, read on the server and handed down
   * whole (ADR 0011, decision 1): the picker matches a typed shortcut against
   * this in the browser, so no keystroke costs a request. Empty is ordinary —
   * a tenant with none, or a library that could not be read — and means the
   * reply box behaves exactly as it did before TAR-484.
   *
   * It arrives again on every route refresh, which is how an admin's edit
   * reaches an agent mid-draft: the inbox socket refetches on
   * `canned_response.saved` and `canned_response.deleted` (`inbox-events.ts`),
   * and this prop is what changes. Nothing here holds a copy — a memoised one
   * would go stale exactly when it matters.
   */
  cannedResponses?: readonly CannedResponseResponse[];
}

export function MessageComposer({
  conversationId,
  serviceWindowExpiresAt,
  initialWindow,
  guidance,
  canWrite,
  cannedResponses = NO_CANNED_RESPONSES,
}: MessageComposerProps) {
  const window = useServiceWindow(serviceWindowExpiresAt, initialWindow);
  const [isPickingTemplate, setIsPickingTemplate] = useState(false);

  useWindowClosedNotice(window);

  return (
    <Stack gap="2" className={styles.composer}>
      <ComposerGuidanceLine guidance={guidance} />

      {canWrite ? (
        <FreeFormComposer
          conversationId={conversationId}
          isWindowOpen={window.state === 'open'}
          cannedResponses={cannedResponses}
          windowHint={<ServiceWindowHint window={window} />}
          templateAction={
            <TemplateTrigger
              isWindowOpen={window.state === 'open'}
              onOpen={() => {
                setIsPickingTemplate(true);
              }}
            />
          }
        />
      ) : null}

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
 * Said rather than left as a missing box: a console that simply showed nothing
 * where the reply goes would read as a broken screen. Quiet rather than filled,
 * because it is guidance about a state, not a failure — see `Notice`.
 */
function ComposerGuidanceLine({ guidance }: { guidance: ComposerGuidance | null }) {
  const content = useContent();

  if (guidance === null) {
    return null;
  }

  // Assigning the content object to the exhaustive record is the check: a new
  // `ComposerGuidance` without a line of copy fails the build here.
  const lines: Record<ComposerGuidance, string> = content.composer.guidance;

  return (
    <Notice tone="info" variant="quiet">
      {lines[guidance]}
    </Notice>
  );
}

/**
 * The way through once the window has shut, and an ordinary option while it is
 * open — which is exactly the difference in emphasis. Never solid: the thread
 * header owns the screen's one accent button.
 */
function TemplateTrigger({ isWindowOpen, onOpen }: { isWindowOpen: boolean; onOpen: () => void }) {
  const content = useContent();

  return (
    <Button variant={isWindowOpen ? 'ghost' : 'secondary'} size="sm" onClick={onOpen}>
      {content.composer.useTemplate}
    </Button>
  );
}

/** Hoisted so the default is one object rather than a new one every render. */
const NO_CANNED_RESPONSES: readonly CannedResponseResponse[] = [];

/**
 * Mirrors `MessageComposer`: the writing surface and its toolbar, each part
 * standing in for itself — so the swap moves nothing under the cursor of an
 * agent already reaching for the box.
 *
 * No `LoadingAnnouncement`: the thread above already announces itself once, and
 * a region announcing its own sub-parts is how a screen reader ends up reading
 * the same loading state twice.
 */
export function MessageComposerSkeleton() {
  return (
    <Stack gap="2" className={styles.composer} aria-hidden="true">
      <FreeFormComposerSkeleton />
    </Stack>
  );
}

/**
 * Announces the window shutting, once, at the moment it happens.
 *
 * The hint in the toolbar changes on its own, but an agent part-way through a
 * reply is looking at the textarea, not at the caption beside Send — and the next
 * thing they would otherwise learn is that Send does not work. The toast is the
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
