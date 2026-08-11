'use client';

import { useEffect, useState } from 'react';

/**
 * Reads the token out of an emailed link's URL fragment, then removes it from the
 * address bar. Usage: `const token = useLinkToken();`
 *
 * Both of TAR-53's emailed links are this shape — `/reset-password#token=…` and
 * `/invite#token=…` — so both screens read them through here rather than each
 * solving the same three problems.
 *
 * The token is in the **fragment**, not the query, and that is load-bearing:
 * browsers never send a fragment to a server, so a live credential stays out of
 * every access log, proxy log and `Referer` header between the recipient's inbox
 * and the API (TAR-53, link shapes). The costs are both paid here — the value is
 * unreadable during server rendering, so the screen needs a mount guard, and it
 * has to be scrubbed once read, so a screenshot or a shoulder does not carry it
 * away.
 *
 * `replaceState` rather than `pushState`: a Back button that puts the token back
 * in the bar would undo the scrub.
 */

export const LINK_TOKEN_FRAGMENT_KEY = 'token';

export type LinkTokenState =
  /** Server render and first paint: the fragment is not readable yet. */
  | { status: 'reading' }
  /** The link arrived without a token — truncated by an email client, usually. */
  | { status: 'missing' }
  | { status: 'present'; token: string };

/**
 * What the fragment said, for as long as this document lives.
 *
 * Scrubbing the fragment destroys the only copy of the token, so the *second*
 * read of `window.location.hash` finds nothing — and a component that mounts
 * twice would conclude the link was broken. React's Strict Mode does exactly
 * that in development, and an error-boundary reset or a Suspense retry can do it
 * in production, so this is a correctness fix rather than a development-only
 * workaround.
 *
 * Module state is safe here because it is only ever written from an effect, which
 * never runs on the server — the module is evaluated per request during SSR but
 * this stays `null` there, so no request can see another's token.
 *
 * Keyed by pathname so a client-side navigation to a different screen cannot pick
 * up a token that was never meant for it.
 */
let scrubbed: { readonly path: string; readonly token: string | null } | null = null;

export function useLinkToken(): LinkTokenState {
  const [state, setState] = useState<LinkTokenState>({ status: 'reading' });

  useEffect(() => {
    const sync = (): void => {
      const token = readToken();

      setState(token === null ? { status: 'missing' } : { status: 'present', token });
    };

    sync();

    /*
     * A second link opened in the same tab differs from the current URL only by
     * its fragment, which the browser treats as a same-document navigation — no
     * reload, no remount. Without this listener somebody who clicks their older
     * reset email, is told the link is dead, and then clicks the newer one is
     * left staring at the same dead-link screen.
     *
     * `replaceState` does not fire `hashchange`, so the scrub inside `readToken`
     * cannot re-enter this.
     */
    window.addEventListener('hashchange', sync);

    return () => {
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  return state;
}

function readToken(): string | null {
  const { hash, pathname, search } = window.location;

  if (hash === '') {
    // Already scrubbed on an earlier mount, or the link never carried a token.
    return scrubbed?.path === pathname ? scrubbed.token : null;
  }

  const raw = new URLSearchParams(hash.replace(/^#/, '')).get(LINK_TOKEN_FRAGMENT_KEY);
  const token = raw === null || raw === '' ? null : raw;

  scrubbed = { path: pathname, token };
  window.history.replaceState(null, '', pathname + search);

  return token;
}
