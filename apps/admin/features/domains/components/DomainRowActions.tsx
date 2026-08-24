'use client';

import { useCallback, useEffect } from 'react';
import type { AdminDomainStatus, AdminPendingDomain } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { content } from '~/content/en';
import { attachDomainAction, detachDomainAction } from '../domains.actions';

/**
 * One row's control (spec §2.3, region 2).
 *
 * **Not confirmed**: attaching is reversible by the control in the other half of
 * the queue, and 0001 reserves confirmation for the irreversible. A dialog on
 * every row of a queue somebody works through is a dialog they learn to dismiss
 * without reading.
 *
 * Which action it is comes from the half being shown rather than from the row.
 * Reading `activatedAt` instead would offer `Attach` on a row the `verified`
 * filter had just returned *because* it is not attached — the same answer, one
 * inference later.
 *
 * A failure is reported by the caller as a banner above the table rather than
 * here, because a successful sibling refetch may have taken this row away.
 */
export function DomainRowActions({
  domain,
  status,
  onFailure,
}: {
  domain: AdminPendingDomain;
  status: AdminDomainStatus;
  onFailure: (hostname: string, message: string) => void;
}) {
  const { showToast } = useToast();
  const isWaiting = status === 'verified';

  const { submit, isPending, formError } = useActionForm({
    perform: useCallback(async () => {
      const input = { slug: domain.tenantSlug, hostname: domain.hostname };

      return isWaiting ? attachDomainAction(input) : detachDomainAction(input);
    }, [domain.hostname, domain.tenantSlug, isWaiting]),
    onSuccess: useCallback(
      (hostname: string) => {
        showToast({
          tone: 'success',
          message: isWaiting
            ? content.domains.attachedToast(hostname)
            : content.domains.detachedToast(hostname),
        });
      },
      [isWaiting, showToast],
    ),
  });

  /*
   * Lifted rather than rendered here. A successful sibling write refetches the
   * queue and this row may move to the other half — so a message drawn inside the
   * row can disappear with it, taking the only account of what went wrong.
   */
  useEffect(() => {
    if (formError !== null) {
      onFailure(domain.hostname, formError);
    }
  }, [domain.hostname, formError, onFailure]);

  return (
    <Button
      variant="secondary"
      size="sm"
      isPending={isPending}
      // The verb *and* the subject: a column of identical "Attach" is a table
      // nobody can use without sight of it.
      aria-label={
        isWaiting
          ? content.domains.attachAria(domain.hostname)
          : content.domains.detachAria(domain.hostname)
      }
      onClick={() => {
        submit();
      }}
    >
      {isWaiting ? content.domains.attach : content.domains.detach}
    </Button>
  );
}
