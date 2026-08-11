'use client';

import dynamic from 'next/dynamic';
import { EmbeddedSignupPanelSkeleton } from './EmbeddedSignupPanel.Skeleton';

/**
 * The Embedded Signup panel, in its own chunk.
 *
 * It pulls in Meta's SDK adapter, the flow's state machine and the connected-
 * account table, none of which any other route needs and none of which is the LCP
 * element — the page's heading and the section frame render without it. Its
 * fallback is the panel's own skeleton, sized from the same copy, so the swap
 * shifts nothing.
 *
 * `ssr: false` because the panel is client-only by nature: it exists to drive a
 * third-party script and a `postMessage` channel, neither of which the server
 * has. Rendering it on the server would produce markup that is inert until
 * hydration, and its skeleton is the better thing to send instead. Nothing here
 * is indexable content — the surface is behind a session and a permission.
 */
export const LazyEmbeddedSignupPanel = dynamic(
  async () => (await import('./EmbeddedSignupPanel')).EmbeddedSignupPanel,
  { ssr: false, loading: () => <EmbeddedSignupPanelSkeleton /> },
);
