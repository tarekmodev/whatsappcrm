'use client';

import { useCallback, useState } from 'react';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { content } from '~/content/en';
import { suspendTenantAction } from '../tenants.actions';

/**
 * Suspension: the most destructive thing on this surface short of deletion.
 *
 * The dialog names exactly what it costs rather than asking "are you sure" —
 * every agent in the tenant loses access on their next request, including through
 * sessions already open, and it happens the moment the call commits.
 *
 * The reason is optional and goes to the trail, never to the tenant (ADR 0009).
 * That second sentence is load-bearing: an operator who does not know it will
 * write for the wrong audience.
 */
export function SuspendTenantDialog({
  slug,
  name,
  isOpen,
  onClose,
}: {
  slug: string;
  /** What the copy calls the tenant. The slug, until a read returns a name. */
  name: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const [reason, setReason] = useState('');

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform: useCallback(async () => suspendTenantAction({ slug, reason }), [reason, slug]),
    onSuccess: useCallback(() => {
      showToast({ tone: 'success', message: content.writes.suspendedToast(name) });
      setReason('');
      onClose();
    }, [name, onClose, showToast]),
  });

  return (
    <FormDialog
      isOpen={isOpen}
      title={content.writes.suspendTitle}
      description={content.writes.suspendBody(name)}
      submitLabel={content.writes.suspendSubmit}
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
