'use client';

import { useCallback, useRef, useState } from 'react';
import { content } from '@/content/en';
import type { ActionResult } from '@/lib/actions/result';

/**
 * Runs a server action from a form and models the result as a discriminated union.
 * Usage:
 *
 * ```tsx
 * const { submit, isPending, formError } = useActionForm({
 *   perform: () => inviteAgentAction(input),
 *   onSuccess: ({ email }) => { showToast(...); onClose(); },
 * });
 * ```
 *
 * Extracted because five dialogs need the identical pending / error / success
 * sequence, and because the two rules that are easy to get wrong belong in one
 * place: never double-submit, and never clear the user's input on failure.
 */

export interface UseActionFormOptions<T> {
  perform: () => Promise<ActionResult<T>>;
  onSuccess: (data: T) => void;
}

export interface UseActionForm {
  submit: () => void;
  isPending: boolean;
  /** Form-level failure, rendered above the actions. Field errors are separate. */
  formError: string | null;
  requestId: string | null;
  clearError: () => void;
}

export function useActionForm<T>({ perform, onSuccess }: UseActionFormOptions<T>): UseActionForm {
  const [isPending, setIsPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  // A ref, not the state value: two clicks in the same tick would both read
  // `isPending === false`.
  const inFlightRef = useRef(false);

  const submit = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setIsPending(true);
    setFormError(null);
    setRequestId(null);

    void perform()
      .then((result) => {
        if (result.status === 'success') {
          onSuccess(result.data);
          return;
        }

        // The form keeps its values: a failed submit must never make the user
        // retype anything.
        setFormError(result.message);
        setRequestId(result.requestId);
      })
      .catch((error: unknown) => {
        // Reaches here only if the action itself failed to run — a network drop or
        // a chunk that would not load. Not swallowed.
        console.error('Action form submission failed', error);
        setFormError(content.form.genericSubmitError);
      })
      .finally(() => {
        inFlightRef.current = false;
        setIsPending(false);
      });
  }, [perform, onSuccess]);

  const clearError = useCallback(() => {
    setFormError(null);
    setRequestId(null);
  }, []);

  return { submit, isPending, formError, requestId, clearError };
}
