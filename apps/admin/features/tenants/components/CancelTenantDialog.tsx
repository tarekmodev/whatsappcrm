'use client';

import { useCallback, useState } from 'react';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { content } from '~/content/en';
import { cancelTenantAction } from '../tenants.actions';

/**
 * Ends the tenant's subscription on its behalf. Effectively reversible —
 * reactivation restores it — but it starts a clock the tenant does not choose,
 * so it is confirmed and it is `danger`.
 */
export function CancelTenantDialog({
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
  const [reason, setReason] = useState('');

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform: useCallback(async () => cancelTenantAction({ slug, reason }), [reason, slug]),
    onSuccess: useCallback(() => {
      showToast({ tone: 'success', message: content.writes.cancelledToast(name) });
      setReason('');
      onClose();
    }, [name, onClose, showToast]),
  });

  return (
    <FormDialog
      isOpen={isOpen}
      title={content.writes.cancelTitle}
      description={content.writes.cancelBody(name)}
      submitLabel={content.writes.cancelSubmit}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onSubmit={submit}
      onClose={() => {
        clearError();
        onClose();
      }}
    >
      <Field label={content.writes.reasonLabel} hint={content.writes.reasonHint}>
        {({ controlId, describedBy }) => (
          <Textarea
            id={controlId}
            aria-describedby={describedBy}
            name="reason"
            rows={3}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}
