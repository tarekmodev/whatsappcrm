'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { TENANT_ROLES, type TenantRole } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FilterBar } from '@/components/ui/FilterBar';
import { SearchField } from '@/components/ui/SearchField';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { useFilterNavigation } from '@/lib/hooks/useFilterNavigation';
import { routes, searchParamKeys, type PeopleQuery } from '@/lib/routes';
import { searchTermParam } from '@/lib/search-params';
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

export function PeopleFilterBar() {
  const content = useContent();
  const searchParams = useSearchParams();

  const roleParam = searchParams.get(searchParamKeys.peopleRole) ?? ALL_ROLES_VALUE;
  const queryParam = searchParams.get(searchParamKeys.peopleQuery) ?? '';

  // Local state only for the in-flight keystrokes; the URL stays the source of truth.
  const [draftQuery, setDraftQuery] = useState(queryParam);
  const debouncedQuery = useDebouncedValue(draftQuery, SEARCH_DEBOUNCE_MS);

  // Both filters navigate through one place, so each carries the other even
  // while the URL that set it is still in flight — see `useFilterNavigation`.
  const filters = useMemo<PeopleQuery>(
    () => ({
      q: searchTermParam(queryParam),
      role: roleParam === ALL_ROLES_VALUE ? undefined : roleParam,
    }),
    [queryParam, roleParam],
  );
  const replaceFilters = useFilterNavigation<PeopleQuery>(filters, routes.settingsPeople);

  // Keeps the box in step when the URL changes from elsewhere — back button,
  // a shared link, a nav click.
  useEffect(() => {
    setDraftQuery(queryParam);
  }, [queryParam]);

  useEffect(() => {
    if (debouncedQuery === queryParam) {
      return;
    }

    replaceFilters({ q: searchTermParam(debouncedQuery) });
  }, [debouncedQuery, queryParam, replaceFilters]);

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

              replaceFilters({
                role: nextRole === ALL_ROLES_VALUE ? undefined : nextRole,
                // The term the box currently *shows*, not the one the URL holds:
                // a role chosen mid-word must not discard the keystrokes the
                // debounce has not fired yet.
                q: searchTermParam(draftQuery),
              });
            }}
          />
        )}
      </Field>
    </FilterBar>
  );
}
