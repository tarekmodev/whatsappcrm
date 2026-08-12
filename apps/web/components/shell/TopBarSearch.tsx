'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import { routes, searchParamKeys, type InboxScope } from '@/lib/routes';
import styles from './TopBarSearch.module.css';

/**
 * The top bar's search field. Usage: `<TopBarSearch />`.
 *
 * It searches **conversations**, and its label says so rather than promising a
 * workspace-wide search this API cannot answer: 0002 exposes `?q=` on
 * `GET /v1/conversations` and on nothing else. 0001 reserved this spot for a
 * field "with the story that adds the endpoint" — the endpoint is there, so the
 * field is honest, and it widens to contacts and tickets when their reads do.
 *
 * A real `<form>` with a real submit. The term lands in the URL
 * (`/inbox?q=…`), which is what makes a search shareable, refreshable and
 * reachable by the back button — and it is the server that runs it, so there is
 * no client-side fetch and nothing to debounce.
 *
 * The scope alongside it is preserved when the search starts from the inbox, so
 * searching does not silently widen an agent's view of the workspace.
 */
export function TopBarSearch() {
  const content = useContent();
  const router = useRouter();
  const params = useSearchParams();
  const submitted = params.get(searchParamKeys.inboxQuery) ?? '';
  const [term, setTerm] = useState(submitted);

  // The URL is the source of truth: arriving on a searched view, or stepping
  // back out of one, has to move the field with it.
  useEffect(() => {
    setTerm(submitted);
  }, [submitted]);

  const scope = params.get(searchParamKeys.inboxScope) ?? undefined;

  function go(nextTerm: string): void {
    router.push(
      routes.inbox({
        scope: scope as InboxScope | undefined,
        q: nextTerm === '' ? undefined : nextTerm,
      }),
    );
  }

  return (
    <form
      className={styles.form}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        go(term.trim());
      }}
    >
      <Icon name="search" size="sm" className={styles.icon} />
      <input
        className={styles.input}
        type="search"
        name={searchParamKeys.inboxQuery}
        value={term}
        placeholder={content.search.placeholder}
        aria-label={content.search.label}
        // A search box that zooms the viewport on focus is an iOS Safari
        // behaviour below 16px; the body size clears it, so nothing is capped.
        autoComplete="off"
        onChange={(event) => {
          setTerm(event.target.value);
        }}
      />
      {submitted === '' ? null : (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            setTerm('');
            go('');
          }}
        >
          <Icon name="close" size="sm" />
          <VisuallyHidden>{content.search.clear}</VisuallyHidden>
        </button>
      )}
      <VisuallyHidden>
        <button type="submit">{content.search.submit}</button>
      </VisuallyHidden>
    </form>
  );
}

/**
 * Mirrors `TopBarSearch`: the same pill, at the same height, with the same icon
 * — so the bar does not shift when the field resolves.
 *
 * Not a `Skeleton`: this stands in for a control rather than for content, it is
 * on screen for a single render, and a shimmering bar in the app's chrome reads
 * as something being wrong with the app.
 */
export function TopBarSearchSkeleton() {
  return (
    <div className={styles.form} aria-hidden="true">
      <Icon name="search" size="sm" className={styles.icon} />
    </div>
  );
}
