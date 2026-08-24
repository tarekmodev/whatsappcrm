import 'server-only';

import { unstable_rethrow } from 'next/navigation';
import { ApiRequestError } from '@/lib/api/http';
import { CredentialRefusedError } from '~/lib/credential';

/**
 * The outcome of one admin read, with the two answers a screen renders itself
 * separated from the ones the boundary should take.
 *
 * Every section on this surface has the same three-way shape — it loaded, the
 * credential was refused, or the thing named does not exist — and writing that
 * `try`/`catch` per section is how one of them ends up swallowing a `redirect`
 * or reporting a rotated token as a generic failure.
 */
export type ReadOutcome<T> =
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'credential-refused' }
  | { readonly status: 'not-found' };

export async function attemptRead<T>(read: () => Promise<T>): Promise<ReadOutcome<T>> {
  try {
    return { status: 'ok', data: await read() };
  } catch (error) {
    // First, and before anything else looks at it: Next signals some control
    // flow — a `redirect`, a `notFound`, an un-prerenderable route — by
    // *throwing*. Caught here and read as a failed request, that signal would be
    // swallowed and the screen would render the wrong thing.
    unstable_rethrow(error);

    if (error instanceof CredentialRefusedError) {
      return { status: 'credential-refused' };
    }

    if (error instanceof ApiRequestError && error.code === 'not_found') {
      return { status: 'not-found' };
    }

    // Everything else — the API down, a malformed response — belongs to the
    // boundary above, which offers a retry this module cannot.
    throw error;
  }
}
