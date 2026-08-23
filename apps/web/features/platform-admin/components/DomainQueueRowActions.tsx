'use client';

import { useCallback } from 'react';
import type { AdminDomainStatus, AdminPendingDomain } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Stack } from '@/components/layout/Stack';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import {
  activateTenantDomainAction,
  deactivateTenantDomainAction,
} from '../platform-admin.actions';

/**
 * The one control at the end of a domain-queue row. Usage:
 * `<DomainQueueRowActions domain={domain} status={status} />`.
 *
 * One action, so `RowActions` is not what this wants: that component exists to
 * apply the weight ladder to *two or more* controls, and a row with a single
 * button is the case its ladder has nothing to say about.
 *
 * Which action it is comes from the queue half being shown rather than from the
 * row: `verified` is waiting to be attached, `live` has been. Reading it from
 * `activatedAt` instead would offer "Mark attached" on a row the `verified`
 * filter had just returned *because* it is not attached — the same answer, one
 * inference later.
 *
 * ## It records; it does not attach
 *
 * Attaching a hostname at the edge and issuing its certificate happens in the
 * hosting dashboard — TAR-416 declined to invent a contract against an API
 * nobody here had read. This writes down that it has been done, and the card
 * above says so, because an operator who presses it expecting a certificate has
 * been misled by a verb.
 *
 * Not confirmed. Marking a domain attached is a bookkeeping write with the
 * inverse control beside it in the other half of the queue, so it is undoable
 * rather than destructive — and a confirmation on every row of a queue somebody
 * works through is a dialog they learn to dismiss without reading.
 */
export function DomainQueueRowActions({
  domain,
  status,
}: {
  domain: AdminPendingDomain;
  /** Which half of the queue this row was returned by. */
  status: AdminDomainStatus;
}) {
  const content = useContent();
  const copy = content.platformAdmin.domains;
  const { showToast } = useToast();
  const isWaiting = status === 'verified';

  const { submit, isPending, formError, requestId } = useActionForm({
    perform: useCallback(async () => {
      const input = { slug: domain.tenantSlug, hostname: domain.hostname };

      return isWaiting ? activateTenantDomainAction(input) : deactivateTenantDomainAction(input);
    }, [domain.hostname, domain.tenantSlug, isWaiting]),
    onSuccess: useCallback(
      (hostname: string) => {
        showToast({
          tone: 'success',
          message: isWaiting ? copy.activatedToast(hostname) : copy.deactivatedToast(hostname),
        });
      },
      [copy, isWaiting, showToast],
    ),
  });

  return (
    <Stack gap="2">
      <Button
        variant={isWaiting ? 'secondary' : 'dangerQuiet'}
        size="sm"
        isPending={isPending}
        // The verb *and the subject*: a column of identical "Mark attached" is a
        // table nobody can use without sight of it.
        aria-label={
          isWaiting ? copy.activateAria(domain.hostname) : copy.deactivateAria(domain.hostname)
        }
        onClick={() => {
          submit();
        }}
      >
        {isWaiting ? copy.activate : copy.deactivate}
      </Button>
      {/*
        In the row rather than in a toast. A toast that has been dismissed is a
        failure nobody can go back and read, and the row is where the operator is
        looking — the success path is the toast, because there the row itself
        moves to the other half of the queue and says so.
      */}
      <FormError message={formError} requestId={requestId} />
    </Stack>
  );
}
