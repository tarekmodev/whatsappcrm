'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  cannedResponseIssues,
  clearIssue,
  hasIssues,
  normaliseShortcut,
  type CannedResponseDraft,
  type CannedResponseIssues,
} from './canned-response-form';

/**
 * The draft a saved-reply dialog is editing, its per-field errors, and the
 * cleaning both dialogs owe the API. Usage:
 *
 * ```tsx
 * const { draft, cleaned, issues, change, normaliseShortcutNow, validate } =
 *   useCannedResponseDraft({ shortcut: '', title: '', body: '' });
 * ```
 *
 * Extracted because the create and edit dialogs need the identical sequence, and
 * because the thing that is easy to get wrong belongs in one place: **`cleaned`
 * is derived, not stored.** Writing the normalised value back into state and
 * then submitting in the same tick sends the value from *before* the write —
 * `useActionForm`'s `perform` closed over the old one — which is how a form that
 * shows `/hours` posts `Hours` and comes back `validation_failed`.
 */

export interface CannedResponseDraftForm {
  /** What is in the boxes, exactly as typed. */
  readonly draft: CannedResponseDraft;
  /** What the API is sent: shortcut normalised, title and body trimmed. */
  readonly cleaned: CannedResponseDraft;
  readonly issues: CannedResponseIssues;
  readonly change: (patch: Partial<CannedResponseDraft>) => void;
  /**
   * Applies the shortcut's normalisation to the box itself, on blur — so an
   * admin who typed `Hours` sees `/hours` before they submit rather than after
   * the dialog has closed over the answer.
   */
  readonly normaliseShortcutNow: () => void;
  /** Reports every issue and answers whether the draft may be sent. */
  readonly validate: () => boolean;
}

export function useCannedResponseDraft(initial: CannedResponseDraft): CannedResponseDraftForm {
  const [draft, setDraft] = useState<CannedResponseDraft>(initial);
  const [issues, setIssues] = useState<CannedResponseIssues>({});

  const change = useCallback((patch: Partial<CannedResponseDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setIssues((current) =>
      Object.keys(patch).reduce<CannedResponseIssues>(
        (remaining, field) => clearIssue(remaining, field as keyof CannedResponseIssues),
        current,
      ),
    );
  }, []);

  const normaliseShortcutNow = useCallback(() => {
    setDraft((current) => ({ ...current, shortcut: normaliseShortcut(current.shortcut) }));
  }, []);

  const cleaned = useMemo<CannedResponseDraft>(
    () => ({
      shortcut: normaliseShortcut(draft.shortcut),
      title: draft.title.trim(),
      body: draft.body.trim(),
    }),
    [draft],
  );

  const validate = useCallback(() => {
    const found = cannedResponseIssues(cleaned);

    setIssues(found);

    return !hasIssues(found);
  }, [cleaned]);

  return { draft, cleaned, issues, change, normaliseShortcutNow, validate };
}
