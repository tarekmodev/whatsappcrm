'use client';

import dynamic from 'next/dynamic';
import { SkeletonLine } from '@/components/ui/Skeleton';

/**
 * The two interactive controls on the billing surface, in their own chunk.
 *
 * Everything else on this page — the plan cards, the price formatting, the
 * feature lists, the meters, all four banners — is a server component, so the
 * only JavaScript this route needs to ship is the two buttons that mint a
 * provider-hosted session and the hook they share. Splitting them keeps that
 * chunk off every other route in the console.
 *
 * `deferUntilVisible` is not used here. The plan buttons sit inside cards a user
 * came to this page specifically to press, and the portal button is the answer to
 * "where are my invoices" — deferring either until it scrolls into view would
 * make the control late for the one interaction the page exists for. The split
 * still keeps the chunk off every other route, which is the part that pays.
 *
 * **SSR stays on.** These are ordinary buttons with no third-party script and no
 * `postMessage` channel, so server-rendering them means the label and the
 * disabled state arrive in the first HTML rather than as a placeholder waiting
 * for hydration — which matters, because whether a plan can be chosen is
 * information, not decoration.
 *
 * Each `loading` fallback is a line the exact height of the control it replaces,
 * so the card's action row reserves its space and nothing shifts when the chunk
 * lands.
 */

export const LazyPlanCheckoutButton = dynamic(
  async () => (await import('./PlanCheckoutButton')).PlanCheckoutButton,
  { loading: () => <SkeletonLine width="100%" height="var(--size-control-md)" /> },
);

export const LazyBillingPortalButton = dynamic(
  async () => (await import('./BillingPortalButton')).BillingPortalButton,
  { loading: () => <SkeletonLine width="12rem" height="var(--size-control-md)" /> },
);
