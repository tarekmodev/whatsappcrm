'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Tag } from '@whatsappcrm/contracts';
import { Cluster } from '@/components/layout/Cluster';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { routes, searchParamKeys } from '@/lib/routes';
import { UNSET_VALUE, tagFilterOptions } from '../presentation';
import styles from './ContactsFilterBar.module.css';

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

const SEARCH_DEBOUNCE_MS = 300;

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
  const router = useRouter();
  const searchParams = useSearchParams();

  const tagParam = searchParams.get(searchParamKeys.contactsTag) ?? UNSET_VALUE;
  const queryParam = searchParams.get(searchParamKeys.contactsQuery) ?? '';

  // Local state only for the in-flight keystrokes; the URL stays the source of truth.
  const [draftQuery, setDraftQuery] = useState(queryParam);
  const debouncedQuery = useDebouncedValue(draftQuery, SEARCH_DEBOUNCE_MS);

  // Keeps the box in step when the URL changes from elsewhere — back button, a
  // shared link, the empty state's "clear filters" link.
  useEffect(() => {
    setDraftQuery(queryParam);
  }, [queryParam]);

  useEffect(() => {
    if (debouncedQuery === queryParam) {
      return;
    }

    router.replace(
      routes.contacts({
        tagId: tagParam === UNSET_VALUE ? undefined : tagParam,
        q: debouncedQuery.trim() === '' ? undefined : debouncedQuery.trim(),
      }),
      // `replace`, so a search does not fill the back stack with every prefix.
      { scroll: false },
    );
  }, [debouncedQuery, queryParam, tagParam, router]);

  return (
    <Cluster gap="3" align="start" className={styles.bar}>
      <div className={styles.search}>
        <Field label={content.contacts.searchLabel} isLabelHidden>
          {({ controlId }) => (
            <TextInput
              id={controlId}
              type="search"
              name="q"
              autoComplete="off"
              placeholder={content.contacts.searchPlaceholder}
              value={draftQuery}
              onChange={(event) => {
                setDraftQuery(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <div className={styles.tag}>
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
              value={tagParam}
              options={tagFilterOptions(tags, tagParam === UNSET_VALUE ? undefined : tagParam)}
              onChange={(event) => {
                const nextTagId = event.target.value;

                router.replace(
                  routes.contacts({
                    tagId: nextTagId === UNSET_VALUE ? undefined : nextTagId,
                    q: queryParam === '' ? undefined : queryParam,
                  }),
                  { scroll: false },
                );
              }}
            />
          )}
        </Field>
      </div>
    </Cluster>
  );
}
