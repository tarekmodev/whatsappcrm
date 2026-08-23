'use client';

import { useEffect, useState } from 'react';
import { readSlugAvailability, type SlugAvailability } from './signup.requests';

/**
 * Asks the API whether a workspace address is free, while somebody is still
 * typing it. Usage:
 *
 * ```ts
 * // `null` for a value that is not worth asking about yet.
 * const availability = useSlugAvailability(slugFieldError(slug) === undefined ? slug : null);
 * ```
 *
 * It exists because of the order the two signup calls happen in. Nothing is
 * provisioned until the emailed link comes back, so the address has to be held
 * between the two — and the customer therefore has to be told it is taken
 * *before* they go and check their inbox, which is the one step they cannot fix
 * without starting over (`packages/contracts/src/signup.ts`).
 *
 * ## Three things it has to get right
 *
 *   - **Debounce.** `SIGNUP_POLICY.slugChecksPerIpPerMinute` is documented as a
 *     backstop rather than a security control, which makes the pacing this
 *     hook's job and not the API's. A check fires on a pause, not on a keystroke.
 *   - **Races.** The answer for `acm` can land after the answer for `acme`.
 *     Every superseded check is aborted, and an aborted one reports `superseded`
 *     so it is dropped rather than rendered.
 *   - **Failure is not invalidity.** A check that could not run answers
 *     `unknown`, and the form still submits: the check is a courtesy and
 *     `POST /signup` is the authority. A console that blocked the button because
 *     it could not reach a *convenience* endpoint would be worse than one that
 *     never had it.
 */

export type SlugAvailabilityState =
  /** Nothing worth asking about: the field is empty, or its shape is wrong. */
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'settled'; availability: Exclude<SlugAvailability, 'superseded'> };

/**
 * Long enough to be a pause rather than a gap between keystrokes, short enough
 * that somebody who has finished typing does not notice waiting for it. Typing
 * an address straight through costs one check at this value.
 */
const CHECK_DEBOUNCE_MS = 400;

export function useSlugAvailability(slug: string | null): SlugAvailabilityState {
  const [state, setState] = useState<SlugAvailabilityState>({ status: 'idle' });

  useEffect(() => {
    if (slug === null) {
      setState({ status: 'idle' });
      return;
    }

    /*
     * Immediately, before the timer rather than inside it. The alternative is
     * leaving the previous value's answer on screen during the debounce, which
     * is a settled-looking "available" underneath an address that is no longer
     * the one it was about.
     */
    setState({ status: 'checking' });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void readSlugAvailability(slug, controller.signal).then((availability) => {
        // Aborted, so either the value changed or the screen is gone. Either way
        // there is nothing left that this answer is about.
        if (availability === 'superseded') {
          return;
        }

        setState({ status: 'settled', availability });
      });
    }, CHECK_DEBOUNCE_MS);

    return () => {
      // Both: the timer for a check that has not left yet, the controller for one
      // that has. Unmounting runs this too, which is what keeps a late answer
      // from setting state on a screen nobody is looking at.
      clearTimeout(timer);
      controller.abort();
    };
  }, [slug]);

  return state;
}
