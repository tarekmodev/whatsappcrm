'use client';

import dynamic from 'next/dynamic';
import { WorkspaceProfileFormSkeleton } from './WorkspaceProfileForm.Skeleton';

/**
 * The profile form, in its own chunk.
 *
 * It is the only interactive thing on this page, and it pulls in the form
 * hook, the toast handle and the client-side validation — none of which the
 * plan panel, the branding summary or the lifecycle banner need, and none of
 * which is the LCP element: the heading, the banner and the plan figures all
 * render without it.
 *
 * `deferUntilVisible` is deliberately off. The profile is the first section on
 * the page, so there is no scroll to wait for and deferring would only make the
 * fields late for somebody who came here to rename their workspace. The split
 * still keeps the chunk off every other route.
 *
 * SSR stays **on**, unlike the WhatsApp panel's boundary. This form has no
 * third-party script and no `postMessage` channel — it is inputs with values
 * the server already holds — so server-rendering it means the fields arrive
 * filled in rather than as a skeleton waiting for hydration.
 */
export const LazyWorkspaceProfileForm = dynamic(
  async () => (await import('./WorkspaceProfileForm')).WorkspaceProfileForm,
  { loading: () => <WorkspaceProfileFormSkeleton /> },
);
