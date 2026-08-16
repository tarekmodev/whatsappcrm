'use client';

import { useState } from 'react';
import { MAX_CUSTOM_DOMAINS_PER_TENANT, type TenantDomain } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { countCustomDomains, hasReachedDomainLimit, orderDomains } from '../domain-presentation';
import { AddDomainDialog } from './AddDomainDialog';
import { DomainCard } from './DomainCard';
import styles from './DomainList.module.css';

/**
 * The tenant's hostnames, and the one control that adds another. Usage:
 * `<DomainList domains={domains} />`.
 *
 * A client component because it owns exactly one piece of state — whether the add
 * dialog is open. The rows themselves are `DomainCard`, one component for both
 * kinds, so nothing here decides what a domain may do; `domainCapabilities` does.
 *
 * The empty state is for a tenant with **no custom domain**, which is every
 * tenant on day one — the platform subdomain is always present and always
 * rendered above it, so this explains the next step rather than claiming the
 * workspace is unreachable.
 */
export function DomainList({ domains }: { domains: readonly TenantDomain[] }) {
  const content = useContent();
  const [isAdding, setIsAdding] = useState(false);
  const ordered = orderDomains(domains);
  const isAtLimit = hasReachedDomainLimit(domains);

  return (
    <Stack gap="4">
      <div className={styles.actions}>
        <Button
          variant="primary"
          // A precondition the plan sets, not a validation refusal — so the
          // reason is stated below rather than left to a disabled button.
          disabled={isAtLimit}
          onClick={() => {
            setIsAdding(true);
          }}
        >
          {content.domains.addButton}
        </Button>
      </div>

      {isAtLimit ? (
        <Notice tone="warning">
          {content.domains.limitReached(MAX_CUSTOM_DOMAINS_PER_TENANT)}
        </Notice>
      ) : null}

      <ul className={styles.list}>
        {ordered.map((domain) => (
          <li key={domain.id}>
            <DomainCard domain={domain} />
          </li>
        ))}
      </ul>

      {countCustomDomains(domains) === 0 ? (
        <EmptyState
          heading={content.domains.emptyHeading}
          body={content.domains.emptyBody}
          action={
            <Button
              variant="primary"
              onClick={() => {
                setIsAdding(true);
              }}
            >
              {content.domains.addButton}
            </Button>
          }
        />
      ) : null}

      <AddDomainDialog
        isOpen={isAdding}
        onClose={() => {
          setIsAdding(false);
        }}
      />
    </Stack>
  );
}
