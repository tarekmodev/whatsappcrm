'use client';

import dynamic from 'next/dynamic';
import { ContactCustomFieldsCardSkeleton } from './ContactCustomFieldsCard.Skeleton';
import { ContactTagsCardSkeleton } from './ContactTagsCard.Skeleton';

/**
 * The profile's two editors, each in its own chunk.
 *
 * They are the only interactive things on the page, and between them they pull
 * in the form hook, the toast handle, the checkbox group and every branch of
 * `CustomFieldControl` — none of which the identity card needs, and none of
 * which is the LCP element: the name, the phone number and the detail list all
 * render without either.
 *
 * SSR stays **on**. These are controls filled from values the server already
 * holds, with no third-party script and no `window` access, so server-rendering
 * them means an agent arrives at fields that are already populated rather than
 * at a skeleton waiting for hydration.
 *
 * `deferUntilVisible` is the caller's decision, not this module's — see
 * `ContactProfileSection`, which defers the custom-field card and not the tags.
 */

export const LazyContactTagsCard = dynamic(
  async () => (await import('./ContactTagsCard')).ContactTagsCard,
  { loading: () => <ContactTagsCardSkeleton /> },
);

export const LazyContactCustomFieldsCard = dynamic(
  async () => (await import('./ContactCustomFieldsCard')).ContactCustomFieldsCard,
  { loading: () => <ContactCustomFieldsCardSkeleton /> },
);
