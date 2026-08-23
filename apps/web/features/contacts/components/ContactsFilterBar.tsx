'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Tag } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FilterBar } from '@/components/ui/FilterBar';
import { SearchField } from '@/components/ui/SearchField';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { useFilterNavigation } from '@/lib/hooks/useFilterNavigation';
import { routes, searchParamKeys, type ContactsQuery } from '@/lib/routes';
import { searchTermParam } from '@/lib/search-params';
import { UNSET_VALUE, tagFilterOptions } from '../presentation';

/**
 * Search and tag filters for the directory. Usage:
 * `<ContactsFilterBar tags={tags} />`.
 *
 * Both filters live in the URL, not in component state, so a refresh, a copied
 * link and the back button all reproduce the same view — "everyone tagged VIP"
 * is a link a supervisor sends. The text box is debounced so typing does not
 * push a history entry per keystroke.
 *
 * One tag, not a set, because `ContactListQuerySchema` takes one `tagId`. A
 * multi-select here would be a control the API answers by ignoring all but one.
 */

export function ContactsFilterBar({
  tags,
  isTruncated = false,
}: {
  tags: readonly Tag[];
  /**
   * The vocabulary read hit its cap. Said out loud rather than swallowed: a tag
   * missing from this dropdown otherwise reads as a tag that does not exist.
   */
  isTruncated?: boolean;
}) {
  const content = useContent();
  const searchParams = useSearchParams();

  const tagParam = searchParams.get(searchParamKeys.contactsTag) ?? UNSET_VALUE;
  const queryParam = searchParams.get(searchParamKeys.contactsQuery) ?? '';

  // Local state only for the in-flight keystrokes; the URL stays the source of truth.
  const [draftQuery, setDraftQuery] = useState(queryParam);
  const debouncedQuery = useDebouncedValue(draftQuery, SEARCH_DEBOUNCE_MS);

  // Both filters navigate through one place, so each carries the other even
  // while the URL that set it is still in flight — see `useFilterNavigation`.
  const filters = useMemo<ContactsQuery>(
    () => ({
      q: searchTermParam(queryParam),
      tagId: tagParam === UNSET_VALUE ? undefined : tagParam,
    }),
    [queryParam, tagParam],
  );
  const replaceFilters = useFilterNavigation<ContactsQuery>(filters, routes.contacts);

  // Keeps the box in step when the URL changes from elsewhere — back button, a
  // shared link, the empty state's "clear filters" link.
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
    <FilterBar label={content.contacts.filtersLabel}>
      <SearchField
        label={content.contacts.searchLabel}
        placeholder={content.contacts.searchPlaceholder}
        value={draftQuery}
        onChange={setDraftQuery}
      />
      <Field
        label={content.contacts.filterTagLabel}
        isLabelHidden
        hint={isTruncated ? content.contacts.tagFilterTruncatedHint : undefined}
      >
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            name="tag"
            variant="filter"
            value={tagParam}
            options={tagFilterOptions(tags, tagParam === UNSET_VALUE ? undefined : tagParam)}
            onChange={(event) => {
              const nextTagId = event.target.value;

              replaceFilters({
                tagId: nextTagId === UNSET_VALUE ? undefined : nextTagId,
                // The term the box currently *shows*, not the one the URL holds:
                // a tag chosen mid-word must not discard the keystrokes the
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
