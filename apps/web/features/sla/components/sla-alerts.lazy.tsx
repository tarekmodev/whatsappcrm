'use client';

import dynamic from 'next/dynamic';
import { SlaAlertsPanelSkeleton } from './SlaAlertsPanel.Skeleton';

/**
 * The alert list, loaded when a supervisor first opens the bell rather than with
 * the app shell.
 *
 * This one earns its boundary more than most: it sits in the *layout*, so
 * without it the panel, its rows and the acknowledgement path would ship on
 * every route in the console — including the inbox, whose LCP has nothing to do
 * with a popup nobody has opened. The bell itself is shell furniture and stays
 * eager; only what is behind it defers.
 *
 * `ssr: false` because the panel only ever mounts in response to a click. There
 * is no server render of it to be had and nothing inside it to index.
 */
export const LazySlaAlertsPanel = dynamic(
  async () => (await import('./SlaAlertsPanel')).SlaAlertsPanel,
  { ssr: false, loading: () => <SlaAlertsPanelSkeleton /> },
);
