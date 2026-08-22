'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TENANT_ROLES, type TenantRole } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FilterBar } from '@/components/ui/FilterBar';
import { SearchField } from '@/components/ui/SearchField';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { routes, searchParamKeys } from '@/lib/routes';
import { roleOptions } from '../presentation';

/**
 * Role and free-text filters for the agents list. Usage:
 * `<PeopleFilterBar />`.
 *
 * Both filters live in the URL, not in component state, so a refresh, a copied
 * link and the back button all reproduce the same view. The text box is debounced
 * so typing does not push a history entry per keystroke.
 *
 * Two groups, so both stay visible: 0001's filter row only collapses the
 * secondary ones behind a menu past that. Neither carries a visible label —
 * "All roles" says what the select filters, and the search box has an icon.
 */

const ALL_ROLES_VALUE = '';
const SEARCH_DEBOUNCE_MS = 300;

export function PeopleFilterBar() {
  const content = useContent();
  const router = useRouter();
  const searchParams = useSearchParams();

  const roleParam = searchParams.get(searchParamKeys.peopleRole) ?? ALL_ROLES_VALUE;
  const queryParam = searchParams.get(searchParamKeys.peopleQuery) ?? '';

  // Local state only for the in-flight keystrokes; the URL stays the source of truth.
  const [draftQuery, setDraftQuery] = useState(queryParam);
  const debouncedQuery = useDebouncedValue(draftQuery, SEARCH_DEBOUNCE_MS);

  // Keeps the box in step when the URL changes from elsewhere — back button,
  // a shared link, a nav click.
  useEffect(() => {
    setDraftQuery(queryParam);
  }, [queryParam]);

  useEffect(() => {
    if (debouncedQuery === queryParam) {
      return;
    }

    router.replace(
      routes.settingsPeople({
        role: roleParam === ALL_ROLES_VALUE ? undefined : roleParam,
        q: debouncedQuery.trim() === '' ? undefined : debouncedQuery.trim(),
      }),
      // `replace`, so a search does not fill the back stack with every prefix.
      { scroll: false },
    );
  }, [debouncedQuery, queryParam, roleParam, router]);

  return (
    <FilterBar label={content.people.filtersLabel}>
      <SearchField
        label={content.people.searchAgentsLabel}
        placeholder={content.people.searchAgentsPlaceholder}
        value={draftQuery}
        onChange={setDraftQuery}
      />
      <Field label={content.people.filterRoleLabel} isLabelHidden>
        {({ controlId }) => (
          <Select
            id={controlId}
            name="role"
            variant="filter"
            value={roleParam}
            options={[
              { value: ALL_ROLES_VALUE, label: content.people.filterRoleAll },
              ...roleOptions(TENANT_ROLES),
            ]}
            onChange={(event) => {
              const nextRole = event.target.value as TenantRole | typeof ALL_ROLES_VALUE;

              router.replace(
                routes.settingsPeople({
                  role: nextRole === ALL_ROLES_VALUE ? undefined : nextRole,
                  q: queryParam === '' ? undefined : queryParam,
                }),
                { scroll: false },
              );
            }}
          />
        )}
      </Field>
    </FilterBar>
  );
}
