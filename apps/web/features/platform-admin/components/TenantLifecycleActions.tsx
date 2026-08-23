'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { TextInput } from '@/components/ui/TextInput';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { reactivateTenantAction, suspendTenantAction } from '../platform-admin.actions';
import type { TenantActionAvailability } from '../tenant-presentation';

/**
 * The two operator actions a tenant's state allows. Usage:
 * `<TenantLifecycleActions slug={slug} availability={tenantActions(status)} />`.
 *
 * Which of them is offered is decided by the caller from the contract's own
 * transition table, so this component renders availability rather than deciding
 * it — and a tenant whose state could not be read is offered neither.
 *
 * ## Both are confirmed, and only one of them had to be
 *
 * Suspension is the most destructive thing on this surface short of deletion:
 * every agent in the tenant stops reaching their data on their next request,
 * including through sessions already open, and it happens the moment the call
 * commits. The dialog names exactly that rather than asking "are you sure".
 *
 * Reactivation is *not* destructive and is confirmed anyway, because on this
 * surface the two buttons sit beside each other and act on somebody else's
 * business. The rule is "confirm or make it undoable"; each of these is the
 * other's undo, which would argue for neither — and a mis-click that takes a
 * paying customer offline for the seconds it takes to notice is still an
 * incident. The confirmation is the cheap half of that trade.
 *
 * The reason box is on the suspend dialog only. It is written to the trail, never
 * shown to the tenant (ADR 0009), and it is optional — an operator acting on an
 * incident must not be blocked by a required field.
 */
export function TenantLifecycleActions({
  slug,
  availability,
}: {
  slug: string;
  availability: TenantActionAvailability;
}) {
  const content = useContent();
  const copy = content.platformAdmin.tenant;
  const { showToast } = useToast();
  const [isConfirmingSuspend, setIsConfirmingSuspend] = useState(false);
  const [isConfirmingReactivate, setIsConfirmingReactivate] = useState(false);
  const [reason, setReason] = useState('');

  const suspension = useActionForm({
    perform: useCallback(async () => suspendTenantAction({ slug, reason }), [reason, slug]),
    onSuccess: useCallback(
      (suspended: string) => {
        setIsConfirmingSuspend(false);
        setReason('');
        showToast({ tone: 'success', message: copy.suspendedToast(suspended) });
      },
      [copy, showToast],
    ),
  });

  const reactivation = useActionForm({
    perform: useCallback(async () => reactivateTenantAction({ slug }), [slug]),
    onSuccess: useCallback(
      (reactivated: string) => {
        setIsConfirmingReactivate(false);
        showToast({ tone: 'success', message: copy.reactivatedToast(reactivated) });
      },
      [copy, showToast],
    ),
  });

  const hasAction = availability.canSuspend || availability.canReactivate;

  return (
    <Stack gap="4">
      {/*
        Outside the dialogs as well as inside them. A dialog that closes on
        success takes its own error region with it, and a failure that arrived
        after the operator dismissed it would otherwise be lost — on a surface
        where the alternative to knowing is a support ticket from the customer.
      */}
      <FormError
        message={suspension.formError ?? reactivation.formError}
        requestId={suspension.requestId ?? reactivation.requestId}
      />

      {hasAction ? (
        <Cluster gap="3">
          {availability.canSuspend ? (
            <Button
              variant="danger"
              onClick={() => {
                setIsConfirmingSuspend(true);
              }}
            >
              {copy.suspend}
            </Button>
          ) : null}
          {availability.canReactivate ? (
            <Button
              variant="primary"
              onClick={() => {
                setIsConfirmingReactivate(true);
              }}
            >
              {copy.reactivate}
            </Button>
          ) : null}
        </Cluster>
      ) : null}

      <Notice tone="info" variant="quiet">
        {copy.unbuiltActionsNotice}
      </Notice>
      <Notice tone="info" variant="quiet">
        {copy.impersonateNotice}
      </Notice>

      <FormDialog
        isOpen={isConfirmingSuspend}
        title={copy.suspendTitle}
        description={copy.suspendBody(slug)}
        submitLabel={copy.suspendConfirm}
        submitVariant="danger"
        isPending={suspension.isPending}
        formError={suspension.formError}
        requestId={suspension.requestId}
        onSubmit={() => {
          suspension.submit();
        }}
        onClose={() => {
          setIsConfirmingSuspend(false);
          suspension.clearError();
        }}
      >
        <Field label={copy.suspendReasonLabel} hint={copy.suspendReasonHint}>
          {({ controlId, describedBy }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              name="reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          )}
        </Field>
      </FormDialog>

      <FormDialog
        isOpen={isConfirmingReactivate}
        title={copy.reactivateTitle}
        description={copy.reactivateBody(slug)}
        submitLabel={copy.reactivateConfirm}
        isPending={reactivation.isPending}
        formError={reactivation.formError}
        requestId={reactivation.requestId}
        onSubmit={() => {
          reactivation.submit();
        }}
        onClose={() => {
          setIsConfirmingReactivate(false);
          reactivation.clearError();
        }}
      >
        {/* No fields: the route takes no body. The dialog is the confirmation. */}
        <></>
      </FormDialog>
    </Stack>
  );
}
