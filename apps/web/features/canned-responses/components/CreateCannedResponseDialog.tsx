'use client';

import { useCallback } from 'react';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { createCannedResponseAction } from '../canned-responses.actions';
import { useCannedResponseDraft } from '../useCannedResponseDraft';
import { CannedResponseFields } from './CannedResponseFields';

/**
 * Adds a saved reply. Usage: `<CreateCannedResponseDialog onClose={…} />`.
 *
 * This is TAR-575: until it existed, the only way to put a reply in the
 * workspace's library was a `curl` against `POST /api/v1/canned-responses`, so
 * TAR-31's second acceptance criterion — an admin edits a canned response and
 * every agent sees it — had no admin half.
 *
 * A duplicate shortcut and the per-tenant cap both come back `conflict`, and
 * `conflict` is in `ACTIONABLE_ERROR_CODES` — so the admin reads the API's own
 * sentence ("a canned response for /hours already exists…") rather than the
 * generic line, and can fix it without guessing which of the three fields was
 * wrong.
 */
export function CreateCannedResponseDialog({ onClose }: { onClose: () => void }) {
  const content = useContent();
  const { showToast } = useToast();
  const form = useCannedResponseDraft(EMPTY_DRAFT);
  const { cleaned, validate } = form;

  const perform = useCallback(async () => {
    return createCannedResponseAction(cleaned);
  }, [cleaned]);

  const onSuccess = useCallback(
    ({ title }: { title: string }) => {
      showToast({ tone: 'success', message: content.cannedResponses.createSuccess(title) });
      onClose();
    },
    [content, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.cannedResponses.createTitle}
      description={content.cannedResponses.createDescription}
      submitLabel={content.cannedResponses.createSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        if (validate()) {
          submit();
        }
      }}
    >
      <CannedResponseFields form={form} isDisabled={isPending} />
    </FormDialog>
  );
}

/** Module scope, so the hook is not handed a new object on every render. */
const EMPTY_DRAFT = { shortcut: '', title: '', body: '' };
