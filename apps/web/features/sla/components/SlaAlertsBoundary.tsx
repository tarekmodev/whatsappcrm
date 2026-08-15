'use client';

import type { ReactNode } from 'react';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';

/**
 * Keeps a failed alert read from taking the console's top bar — and therefore
 * every route — down with it. Usage: around `SlaAlertsSection` in the layout.
 *
 * ## Why it renders nothing rather than an error card
 *
 * `SectionErrorBoundary`'s default fallback is a heading, a sentence and a Retry
 * button. That is right inside a page and wrong in a 56px bar, where it would
 * push the search field onto its own line on every screen in the app.
 *
 * Nothing is also better than a bell with no count: a bell reads as "you have no
 * alerts", which would be a claim this console just failed to check. The breach
 * itself is still visible — the ticket queue flags it, and the alert row is the
 * durable record (ADR 0006 decision 5) — so the supervisor loses the shortcut,
 * not the signal. The boundary still logs, so the failure is not silent to
 * anybody looking at a console or, once TAR-41 lands, at the error tracker.
 *
 * ## Why it is its own file
 *
 * `fallback` is a function, and a function cannot cross from a Server Component
 * into a Client Component. The layout is a server component; this is the client
 * boundary that owns the callback.
 */
export function SlaAlertsBoundary({ children }: { children: ReactNode }) {
  return <SectionErrorBoundary fallback={() => null}>{children}</SectionErrorBoundary>;
}
