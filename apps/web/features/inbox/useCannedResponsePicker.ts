'use client';

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import {
  insertCannedResponse,
  matchCannedResponses,
  shortcutTokenBefore,
  type ShortcutToken,
} from '@/features/inbox/canned-response-match';

/**
 * The composer's shortcut picker, as state: which token is under the caret, what
 * it matches, which match is highlighted, and what committing one does to the
 * draft. Usage:
 *
 * ```tsx
 * const picker = useCannedResponsePicker({ responses, draft, onDraftChange, textareaRef });
 * ```
 *
 * A hook rather than state inside the composer, because none of this is the
 * reply form's business: the form owns a draft and a send, and this owns a menu
 * over a token. `canned-response-match` owns the rules; this owns *when* they
 * are applied and what the keyboard does about it.
 *
 * ## The Enter key
 *
 * The one thing that must not happen is a canned response reaching a customer
 * without an agent reading it. While the picker is open, `Enter` commits the
 * highlighted entry and nothing else — `preventDefault` stops the newline it
 * would otherwise insert, and the composer's send has always been a submit
 * button rather than a keystroke, so there is no path from this key to a send.
 */

interface OpenPicker {
  readonly token: ShortcutToken;
  /** The caret the token was read at. Insertion replaces up to exactly here. */
  readonly caret: number;
}

export interface CannedResponsePicker {
  readonly isOpen: boolean;
  readonly matches: readonly CannedResponseResponse[];
  readonly activeIndex: number;
  readonly listboxId: string;
  /** For the textarea's `aria-activedescendant`; absent while the picker is shut. */
  readonly activeOptionId: string | undefined;
  readonly optionId: (index: number) => string;
  /** Call with the textarea's value and selection, on both change and caret move. */
  readonly sync: (draft: string, selectionStart: number, selectionEnd: number) => void;
  /** Returns true when it handled the key, so the caller knows to stop. */
  readonly handleKeyDown: (key: string) => boolean;
  readonly commit: (index: number) => void;
  readonly close: () => void;
}

export interface UseCannedResponsePickerOptions {
  /** The tenant's whole library, server-rendered. Empty means no picker, ever. */
  responses: readonly CannedResponseResponse[];
  draft: string;
  onDraftChange: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useCannedResponsePicker({
  responses,
  draft,
  onDraftChange,
  textareaRef,
}: UseCannedResponsePickerOptions): CannedResponsePicker {
  const baseId = useId();
  const [open, setOpen] = useState<OpenPicker | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  /**
   * The token `Escape` dismissed. Kept so the picker stays shut while the agent
   * finishes typing that token, and opens again as soon as they type a different
   * one — dismissing a menu should not disable the feature for the rest of the
   * draft.
   */
  const dismissedRef = useRef<string | null>(null);
  /** Where the caret goes once React has rendered the inserted body. */
  const pendingCaretRef = useRef<number | null>(null);
  /** The draft and caret the last commit produced, so it cannot re-open itself. */
  const committedRef = useRef<{ draft: string; caret: number } | null>(null);

  const matches = open === null ? EMPTY : matchCannedResponses(responses, open.token.query);
  const isOpen = matches.length > 0;
  // Clamped rather than trusted: a narrowing query shortens the list in the same
  // render that still holds the index the agent had arrowed down to.
  const activeIndex = matches.length === 0 ? 0 : Math.min(highlighted, matches.length - 1);

  const close = useCallback(() => {
    setOpen(null);
  }, []);

  const sync = useCallback(
    (nextDraft: string, selectionStart: number, selectionEnd: number): void => {
      // A selected range has no single caret to insert at, and an agent dragging
      // over their draft is not typing a shortcut.
      if (selectionStart !== selectionEnd) {
        setOpen(null);
        return;
      }

      // The caret move that follows an insertion is the insertion's own, not the
      // agent's. Without this a body ending in something like `see /hours` would
      // re-open the picker over the text just inserted.
      const committed = committedRef.current;

      if (
        committed !== null &&
        committed.draft === nextDraft &&
        committed.caret === selectionStart
      ) {
        committedRef.current = null;
        setOpen(null);
        return;
      }

      const token = shortcutTokenBefore(nextDraft, selectionStart);

      if (token === null) {
        dismissedRef.current = null;
        setOpen(null);
        return;
      }

      if (dismissedRef.current === token.query) {
        setOpen(null);
        return;
      }

      // Same token under the same caret: nothing has changed, so the highlight
      // stays where the arrow keys put it.
      //
      // Not a micro-optimisation. React reports a selection alongside the very
      // keystroke that moved the highlight, so re-opening on identical input
      // put the picker back on its first row — `ArrowDown` then `Enter` inserted
      // the entry *above* the one the agent was looking at. Found in a real
      // browser; jsdom's event plugins do not reproduce the pairing, so
      // `useCannedResponsePicker.test.ts` pins the invariant directly instead.
      if (
        open !== null &&
        open.token.start === token.start &&
        open.token.query === token.query &&
        open.caret === selectionStart
      ) {
        return;
      }

      dismissedRef.current = null;
      setOpen({ token, caret: selectionStart });
      setHighlighted(0);
    },
    [open],
  );

  const commit = useCallback(
    (index: number): void => {
      const chosen = matches[index];

      if (open === null || chosen === undefined) {
        return;
      }

      const inserted = insertCannedResponse(draft, open.token, open.caret, chosen.body);

      committedRef.current = { draft: inserted.draft, caret: inserted.caret };
      pendingCaretRef.current = inserted.caret;
      dismissedRef.current = null;
      setOpen(null);
      onDraftChange(inserted.draft);
    },
    [draft, matches, onDraftChange, open],
  );

  const handleKeyDown = useCallback(
    (key: string): boolean => {
      if (!isOpen) {
        return false;
      }

      if (key === 'ArrowDown') {
        setHighlighted((activeIndex + 1) % matches.length);
        return true;
      }

      if (key === 'ArrowUp') {
        setHighlighted((activeIndex - 1 + matches.length) % matches.length);
        return true;
      }

      if (key === 'Enter' || key === 'Tab') {
        commit(activeIndex);
        return true;
      }

      if (key === 'Escape') {
        dismissedRef.current = open?.token.query ?? null;
        setOpen(null);
        return true;
      }

      return false;
    },
    [activeIndex, commit, isOpen, matches.length, open],
  );

  // After the inserted body has rendered, put the caret at its end so the agent
  // carries on typing where the response finished rather than at the top of it.
  useEffect(() => {
    const caret = pendingCaretRef.current;

    if (caret === null) {
      return;
    }

    pendingCaretRef.current = null;
    const textarea = textareaRef.current;

    if (textarea === null) {
      return;
    }

    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [draft, textareaRef]);

  return {
    isOpen,
    matches,
    activeIndex,
    listboxId: `${baseId}-canned`,
    activeOptionId: isOpen ? `${baseId}-canned-${String(activeIndex)}` : undefined,
    optionId: (index) => `${baseId}-canned-${String(index)}`,
    sync,
    handleKeyDown,
    commit,
    close,
  };
}

const EMPTY: readonly CannedResponseResponse[] = [];
