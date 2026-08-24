'use client';

import { useCallback } from 'react';
import { FormDialog } from '@/components/ui/FormDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { content } from '~/content/en';
import { reactivateTenantAction } from '../tenants.actions';

/**
 * Suspension's inverse, and the only write here that is not destructive.
 *
 * Confirmed anyway, because on this surface it sits beside Suspend in the same
 * menu and acts on somebody else's business — the rule is "confirm or make it
 * undoable", and a mis-click that changes a paying customer's state is worth the
 * cheap half of that trade. No fields: the route takes no body.
 */
export function ReactivateTenantDialog({
  slug,
  name,
  isOpen,
  onClose,
}: {
  slug: string;
  name: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { showToast } = useToast();

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform: useCallback(async () => reactivateTenantAction({ slug }), [slug]),
    onSuccess: useCallback(() => {
      showToast({ tone: 'success', message: content.writes.reactivatedToast(name) });
      onClose();
    }, [name, onClose, showToast]),
  });

  return (
    <FormDialog
      isOpen={isOpen}
      title={content.writes.reactivateTitle}
      description={content.writes.reactivateBody(name)}
      submitLabel={content.writes.reactivateSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onSubmit={submit}
      onClose={() => {
        clearError();
        onClose();
      }}
    >
      <></>
    </FormDialog>
  );
}
