'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KNOWLEDGE_DOCUMENT_STATUSES, type KnowledgeDocumentStatus } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FilterBar } from '@/components/ui/FilterBar';
import { SearchField } from '@/components/ui/SearchField';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { routes, searchParamKeys } from '@/lib/routes';
import { KNOWLEDGE_QUERY_MAX_LENGTH } from '../constants';
import { ALL_STATUSES_VALUE, knowledgeStatusFilterOptions } from '../presentation';

/**
 * Title search and status filter for the knowledge base table. Usage:
 * `<KnowledgeFilterBar />`.
 *
 * Both filters live in the URL, not in component state, so a refresh, a copied
 * link and the back button all reproduce the same view — "everything that failed
 * to index" is a link an admin sends. The text box is debounced so typing does
 * not push a navigation per keystroke; the select navigates immediately, because
 * a discrete choice has nothing to debounce.
 *
 * **`q` matches the title only** — the contract calls it "a plain
 * case-insensitive match over `title`, a console filter, not the retrieval
 * path". The placeholder says so, and the no-results state explains it, because
 * an admin searching for a phrase they remember from the *text* of an entry will
 * otherwise read a working filter as a broken one.
 *
 * Two groups, so both stay visible: 0001's filter row only collapses the
 * secondary ones behind a menu past three. Neither carries a visible label —
 * "All statuses" says what the select filters, and the search box has an icon
 * and a placeholder naming the field it matches.
 *
 * Its Suspense boundary is deliberately **unkeyed**, unlike the table's: a `key`
 * change remounts a subtree unconditionally, which would destroy `draftQuery`
 * and the caret on every debounce tick.
 */
export function KnowledgeFilterBar() {
  const content = useContent();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Narrowed here rather than read raw, so a hand-edited `?status=archived`
  // leaves the select on "All statuses" instead of on a value none of its
  // options carries.
  const statusParam = asStatus(searchParams.get(searchParamKeys.knowledgeStatus));
  const queryParam = searchParams.get(searchParamKeys.knowledgeQuery) ?? '';

  // Local state only for the in-flight keystrokes; the URL stays the source of truth.
  const [draftQuery, setDraftQuery] = useState(queryParam);
  const debouncedQuery = useDebouncedValue(draftQuery, SEARCH_DEBOUNCE_MS);

  // Keeps the box in step when the URL changes from elsewhere — the back button,
  // a shared link, the empty state's "clear filters" link.
  useEffect(() => {
    setDraftQuery(queryParam);
  }, [queryParam]);

  useEffect(() => {
    if (debouncedQuery === queryParam) {
      return;
    }

    router.replace(
      routes.settingsChatbot({
        q: debouncedQuery.trim() === '' ? undefined : debouncedQuery.trim(),
        status: statusParam,
      }),
      // `replace`, so a search does not fill the back stack with every prefix.
      { scroll: false },
    );
  }, [debouncedQuery, queryParam, statusParam, router]);

  return (
    <FilterBar label={content.chatbot.knowledgeFiltersLabel}>
      <SearchField
        label={content.chatbot.searchEntriesLabel}
        placeholder={content.chatbot.searchEntriesPlaceholder}
        name={searchParamKeys.knowledgeQuery}
        // The contract's own ceiling. Past it the parser drops the term, and a
        // search box that silently stops working is worse than one that stops
        // accepting input.
        maxLength={KNOWLEDGE_QUERY_MAX_LENGTH}
        value={draftQuery}
        onChange={setDraftQuery}
      />
      <Field label={content.chatbot.filterStatusLabel} isLabelHidden>
        {({ controlId }) => (
          <Select
            id={controlId}
            name={searchParamKeys.knowledgeStatus}
            variant="filter"
            value={statusParam ?? ALL_STATUSES_VALUE}
            options={knowledgeStatusFilterOptions(content)}
            onChange={(event) => {
              router.replace(
                routes.settingsChatbot({
                  // The term the box currently *shows*, not the one the URL
                  // holds: a status chosen mid-word must not discard the
                  // keystrokes the debounce has not fired yet.
                  q: draftQuery.trim() === '' ? undefined : draftQuery.trim(),
                  status: asStatus(event.target.value),
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

/**
 * A status the contract names, or `undefined` for every entry.
 *
 * Narrowed against the contract's own list rather than cast: the empty option,
 * an absent parameter and a hand-edited one are all the same view, and none of
 * them may reach the API as a query it answers 400. `withQuery` drops the
 * `undefined`, so the unfiltered link stays a bare `/settings/chatbot`.
 */
function asStatus(value: string | null): KnowledgeDocumentStatus | undefined {
  return KNOWLEDGE_DOCUMENT_STATUSES.find((status) => status === value);
}
