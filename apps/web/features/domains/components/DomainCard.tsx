'use client';

import { useCallback, useState } from 'react';
import type { TenantDomain } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FormDialog } from '@/components/ui/FormDialog';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/ToastProvider';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { removeDomainAction, setPrimaryDomainAction, verifyDomainAction } from '../domains.actions';
import { domainCapabilities, domainStatusTone } from '../domain-presentation';
import { DnsRecord } from './DnsRecord';
import styles from './DomainCard.module.css';

/**
 * One hostname, its state and everything that can be done to it. Usage:
 * `<DomainCard domain={domain} />` — one component for the platform subdomain and
 * for a custom domain, because they differ only in what `domainCapabilities`
 * allows and in whether they carry DNS records.
 *
 * The card always says **what is true and what to do next**: a pending domain
 * shows the exact TXT record and, once verified, the routing record; a failed
 * check says which of the four things went wrong rather than "not verified".
 * That is the difference between a supervisor fixing a typo in ten seconds and
 * filing a support ticket.
 */
export function DomainCard({ domain }: { domain: TenantDomain }) {
  const content = useContent();
  const { showToast } = useToast();
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false);
  const capabilities = domainCapabilities(domain);

  const verification = useActionForm({
    perform: useCallback(async () => verifyDomainAction(domain.id), [domain.id]),
    onSuccess: useCallback(
      (checked: TenantDomain) => {
        // The request succeeded either way; what differs is whether the record
        // was there. Saying "verified" on a check that found nothing would be
        // the one lie this screen cannot afford.
        showToast(
          checked.verifiedAt === null
            ? { tone: 'info', message: content.domains.stillPendingToast(checked.hostname) }
            : { tone: 'success', message: content.domains.verifiedToast(checked.hostname) },
        );
      },
      [content, showToast],
    ),
  });

  const promotion = useActionForm({
    perform: useCallback(async () => setPrimaryDomainAction(domain.id), [domain.id]),
    onSuccess: useCallback(() => {
      showToast({ tone: 'success', message: content.domains.setPrimaryToast(domain.hostname) });
    }, [content, domain.hostname, showToast]),
  });

  const removal = useActionForm({
    perform: useCallback(async () => removeDomainAction(domain.id), [domain.id]),
    onSuccess: useCallback(() => {
      setIsConfirmingRemoval(false);
      showToast({ tone: 'success', message: content.domains.removedToast(domain.hostname) });
    }, [content, domain.hostname, showToast]),
  });

  return (
    <article className={styles.card} aria-labelledby={`${domain.id}-hostname`}>
      <Stack gap="4">
        <Cluster justify="between" align="start" gap="3">
          <div className={styles.identity}>
            <h3 id={`${domain.id}-hostname`} className={styles.hostname}>
              {domain.hostname}
            </h3>
            <p className={styles.kind}>{content.domains.kinds[domain.kind]}</p>
          </div>
          <Cluster gap="2" align="center">
            {domain.isPrimary ? <Badge tone="accent">{content.domains.primaryBadge}</Badge> : null}
            <Badge tone={domainStatusTone(domain.status)}>
              {content.domains.statuses[domain.status]}
            </Badge>
          </Cluster>
        </Cluster>

        <p className={styles.statusBody}>{content.domains.statusDescriptions[domain.status]}</p>
        {domain.isPrimary ? (
          <p className={styles.statusBody}>{content.domains.primaryExplanation}</p>
        ) : null}

        <FormError
          message={verification.formError ?? promotion.formError}
          requestId={verification.requestId ?? promotion.requestId}
        />

        {domain.verification === null ? null : (
          <VerificationSteps domain={domain} verification={domain.verification} />
        )}

        {domain.routing === null ? null : (
          <Stack gap="2">
            <h4 className={styles.stepHeading}>{content.domains.routingHeading}</h4>
            <p className={styles.stepBody}>{content.domains.routingBody}</p>
            <DnsRecord
              type={domain.routing.recordType}
              name={domain.routing.recordName}
              value={domain.routing.recordValue}
            />
          </Stack>
        )}

        <div className={styles.actions}>
          {capabilities.canVerify ? (
            <Button
              variant="primary"
              isPending={verification.isPending}
              onClick={() => {
                verification.submit();
              }}
            >
              {content.domains.verifyButton}
            </Button>
          ) : null}
          {capabilities.canMakePrimary ? (
            <Button
              variant="secondary"
              isPending={promotion.isPending}
              onClick={() => {
                promotion.submit();
              }}
            >
              {content.domains.setPrimaryButton}
            </Button>
          ) : null}
          {capabilities.canRemove ? (
            <Button
              variant="danger"
              onClick={() => {
                setIsConfirmingRemoval(true);
              }}
            >
              {content.domains.removeButton}
            </Button>
          ) : (
            // Said out loud rather than left as a missing button: an admin
            // looking for how to remove their platform subdomain deserves the
            // reason, not silence.
            <p className={styles.notRemovable}>{content.domains.platformNotRemovable}</p>
          )}
        </div>
      </Stack>

      <FormDialog
        isOpen={isConfirmingRemoval}
        title={content.domains.removeConfirmTitle(domain.hostname)}
        description={content.domains.removeConfirmBody}
        submitLabel={content.domains.removeConfirm}
        submitVariant="danger"
        isPending={removal.isPending}
        formError={removal.formError}
        requestId={removal.requestId}
        onSubmit={() => {
          removal.submit();
        }}
        onClose={() => {
          setIsConfirmingRemoval(false);
          removal.clearError();
        }}
      >
        {/* The extra consequence, and only when it applies: removing the primary
            moves every invite and reset link back to the platform subdomain. */}
        {domain.isPrimary ? (
          <Notice tone="warning">{content.domains.removePrimaryWarning}</Notice>
        ) : null}
      </FormDialog>
    </article>
  );
}

/**
 * The TXT challenge, plus what the last check found.
 *
 * `lastFailureReason` is rendered as the four-way taxonomy the contract
 * publishes: "we could not find that record yet" and "a record exists but its
 * value does not match" send somebody to two completely different places, and
 * flattening them into "not verified" is what turns a typo into a support ticket.
 */
function VerificationSteps({
  domain,
  verification,
}: {
  domain: TenantDomain;
  verification: NonNullable<TenantDomain['verification']>;
}) {
  const content = useContent();

  return (
    <Stack gap="2">
      <h4 className={styles.stepHeading}>{content.domains.verificationHeading}</h4>
      <p className={styles.stepBody}>{content.domains.verificationBody}</p>
      <DnsRecord
        type={verification.recordType}
        name={verification.recordName}
        value={verification.recordValue}
      />
      {verification.lastFailureReason === null ? null : (
        <Notice tone="warning">
          {content.domains.failureReasons[verification.lastFailureReason]}
        </Notice>
      )}
      <p className={styles.checkedAt}>
        {verification.lastCheckedAt === null ? (
          content.domains.neverChecked
        ) : (
          <>
            {`${content.domains.lastCheckedLabel} `}
            <RelativeTime
              isoTimestamp={verification.lastCheckedAt}
              label={content.domains.lastCheckedLabel}
            />
          </>
        )}
      </p>
      {domain.verifiedAt === null ? (
        <p className={styles.checkedAt}>
          {`${content.domains.expiresLabel} `}
          <RelativeTime
            isoTimestamp={verification.expiresAt}
            label={content.domains.expiresLabel}
          />
        </p>
      ) : null}
    </Stack>
  );
}
