'use client';

import { useEffect, useId, useRef, useState } from 'react';
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
 *
 * ## Below 48rem it is an icon (TAR-522)
 *
 * A permanent field there is a whole row of chrome for a control that is used
 * once a session, and sharing the row instead leaves it about 30px wide. So the
 * field collapses to a trigger and expands back *over* the bar: the bar stays
 * one `--size-bar` row either way, because the expanded panel is out of flow.
 *
 * Activating it moves focus into the field; Escape and the close button collapse
 * it and hand focus back to the trigger. Nothing is trapped — the panel is not
 * modal, and tabbing out of it is allowed to leave.
 *
 * A collapsed trigger must not hide an applied search, so it carries a mark and
 * says the term in its accessible name. The term itself is in the URL, which is
 * what the reader would go back to anyway.
 *
 * From 48rem up the module file pins it open: the trigger and the close button
 * are gone and the field is simply in the bar. `isExpanded` still flips there —
 * Escape in the field sets it — and that is deliberately inert. Focus is handed
 * back only to a trigger that is on screen, so pressing Escape at a desktop
 * width leaves the caret where it was rather than dropping it on a hidden
 * control.
 */
export function TopBarSearch() {
  const content = useContent();
  const router = useRouter();
  const params = useSearchParams();
  const submitted = params.get(searchParamKeys.inboxQuery) ?? '';
  const [term, setTerm] = useState(submitted);
  const [isExpanded, setIsExpanded] = useState(false);
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The URL is the source of truth: arriving on a searched view, or stepping
  // back out of one, has to move the field with it.
  useEffect(() => {
    setTerm(submitted);
  }, [submitted]);

  // Focus follows the disclosure, in both directions, and only on a change the
  // reader made — the initial render must not steal the caret from the page.
  const wasExpandedRef = useRef(false);

  useEffect(() => {
    if (isExpanded && !wasExpandedRef.current) {
      inputRef.current?.focus();
    }

    if (!isExpanded && wasExpandedRef.current) {
      // A no-op where the module file has hidden the trigger, which is exactly
      // what should happen at a width where the field never collapsed.
      triggerRef.current?.focus();
    }

    wasExpandedRef.current = isExpanded;
  }, [isExpanded]);

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
    <div className={styles.root} data-expanded={isExpanded ? 'true' : 'false'}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={isExpanded}
        aria-controls={fieldId}
        aria-label={
          submitted === '' ? content.search.label : content.search.labelWithTerm(submitted)
        }
        onClick={() => {
          setIsExpanded(true);
        }}
      >
        <Icon name="search" />
        {/* Decoration: the trigger's accessible name already carries the term,
            and a mark that announced itself would say it twice. */}
        {submitted === '' ? null : <span className={styles.applied} aria-hidden="true" />}
      </button>

      <div className={styles.panel}>
        {/* Leading, where the drawer trigger it covers was: the field is closed
            from the same corner the bar is left from, and it keeps this × away
            from the clear × inside the pill. */}
        <button
          type="button"
          className={styles.close}
          onClick={() => {
            setIsExpanded(false);
          }}
        >
          <Icon name="close" />
          <VisuallyHidden>{content.search.close}</VisuallyHidden>
        </button>

        <form
          id={fieldId}
          className={styles.form}
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            go(term.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setIsExpanded(false);
            }
          }}
        >
          <Icon name="search" size="sm" className={styles.icon} />
          <input
            ref={inputRef}
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
      </div>
    </div>
  );
}

/**
 * Mirrors `TopBarSearch`: the same trigger in the same box below the layout
 * breakpoint, and the same pill at the same height above it — so the bar does
 * not shift when the field resolves.
 *
 * Not a `Skeleton`: this stands in for a control rather than for content, it is
 * on screen for a single render, and a shimmering bar in the app's chrome reads
 * as something being wrong with the app.
 */
export function TopBarSearchSkeleton() {
  return (
    <div className={styles.root} data-expanded="false" aria-hidden="true">
      <span className={styles.trigger}>
        <Icon name="search" />
      </span>
      <div className={styles.panel}>
        <div className={styles.form}>
          <Icon name="search" size="sm" className={styles.icon} />
        </div>
      </div>
    </div>
  );
}
