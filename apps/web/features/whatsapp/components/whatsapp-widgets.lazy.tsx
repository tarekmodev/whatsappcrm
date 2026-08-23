'use client';

import dynamic from 'next/dynamic';
import { WhatsAppConnectWizardSkeleton } from './WhatsAppConnectWizard.Skeleton';

/**
 * The connect wizard, in its own chunk.
 *
 * It pulls in Meta's SDK adapter, the flow's state machine, the contract schema
 * the resume reads storage back through and the connected-account table, none of
 * which any other route needs and none of which is the LCP element — the page's
 * heading and the section frame render without it. Its fallback is the wizard's
 * own skeleton, built from the same copy, so the swap shifts nothing.
 *
 * `ssr: false` because the wizard is client-only by nature, and load-bearingly
 * so: it drives a third-party script and a `postMessage` channel, neither of
 * which the server has, and it restores its progress from `sessionStorage`
 * during its first render — which is only safe because there is no server render
 * for that restored value to disagree with. Rendering it on the server would
 * produce markup that is inert until hydration, and its skeleton is the better
 * thing to send instead. Nothing here is indexable content — the surface is
 * behind a session and a permission.
 */
export const LazyWhatsAppConnectWizard = dynamic(
  async () => (await import('./WhatsAppConnectWizard')).WhatsAppConnectWizard,
  { ssr: false, loading: () => <WhatsAppConnectWizardSkeleton /> },
);
