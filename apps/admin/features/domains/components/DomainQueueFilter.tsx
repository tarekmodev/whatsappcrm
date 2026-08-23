'use client';

import { useRouter } from 'next/navigation';
import type { AdminDomainStatus } from '@whatsappcrm/contracts';
import { FilterBar } from '@/components/ui/FilterBar';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { content } from '~/content/en';
import { domainQueueHref, domainQueueOptions } from '../domain-queue';

/**
 * The queue's one filter (spec §2.3, region 2): which half is shown, in the URL.
 *
 * A `Select variant="filter"` in a `FilterBar`, which is 0001's list-view
 * pattern — and the value navigates rather than setting state, because "here is
 * what is still waiting" is a link an operator sends, and a refresh or a back
 * button has to reproduce it.
 */
export function DomainQueueFilter({ status }: { status: AdminDomainStatus }) {
  const router = useRouter();

  return (
    <FilterBar label={content.domains.filterLabel}>
      <Field label={content.domains.filterLabel} isLabelHidden>
        {({ controlId }) => (
          <Select
            id={controlId}
            variant="filter"
            name="status"
            aria-label={content.domains.filterLabel}
            value={status}
            options={domainQueueOptions()}
            onChange={(event) => {
              router.push(domainQueueHref(event.target.value as AdminDomainStatus));
            }}
          />
        )}
      </Field>
    </FilterBar>
  );
}
