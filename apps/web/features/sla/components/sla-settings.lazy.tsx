'use client';

import dynamic from 'next/dynamic';
import { SlaWindowFormSkeleton } from './SlaWindowForm.Skeleton';

/**
 * The response-window form, in its own chunk.
 *
 * It is the only interactive thing on this page — everything else is the header,
 * a notice and, where the workspace has them, a read-only list of per-priority
 * overrides, all of which render on the server. Splitting it keeps the form
 * hook, the toast handle and the client-side validation off every other route.
 *
 * `deferUntilVisible` is deliberately off. The window is the first section on
 * the page, so there is no scroll to wait for and deferring would only make the
 * fields late for somebody who came here to change them.
 *
 * SSR stays **on**: this is inputs holding values the server already has, so
 * server-rendering it means the fields arrive filled in rather than as a
 * skeleton waiting for hydration.
 *
 * The fallback is the form's own skeleton, sized identically, so the swap
 * produces no layout shift. `LazyBoundary` supplies the Suspense and error
 * boundary around it.
 */
export const LazySlaWindowForm = dynamic(
  async () => (await import('./SlaWindowForm')).SlaWindowForm,
  { loading: () => <SlaWindowFormSkeleton /> },
);
