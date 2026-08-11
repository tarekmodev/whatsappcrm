'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TENANT_ROLES, type TenantRole } from '@whatsappcrm/contracts';
import { Cluster } from '@/components/layout/Cluster';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { routes, searchParamKeys } from '@/lib/routes';
import { roleOptions } from '../presentation';
import styles from './PeopleFilterBar.module.css';

/**
 * Role and free-text filters for the agents list. Usage:
 * `<PeopleFilterBar />`.
 *
 * Both filters live in the URL, not in component state, so a refresh, a copied
 * link and the back button all reproduce the same view. The text box is debounced
 * so typing does not push a history entry per keystroke.
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
    <Cluster gap="3" align="start" className={styles.bar}>
      <div className={styles.search}>
        <Field label={content.people.searchAgentsLabel} isLabelHidden>
          {({ controlId }) => (
            <TextInput
              id={controlId}
              type="search"
              name="q"
              autoComplete="off"
              placeholder={content.people.searchAgentsPlaceholder}
              value={draftQuery}
              onChange={(event) => {
                setDraftQuery(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <div className={styles.role}>
        <Field label={content.people.filterRoleLabel} isLabelHidden>
          {({ controlId }) => (
            <Select
              id={controlId}
              name="role"
              value={roleParam}
              options={[
                { value: ALL_ROLES_VALUE, label: content.common.all },
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
      </div>
    </Cluster>
  );
}
