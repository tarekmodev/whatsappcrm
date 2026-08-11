'use client';

import { useInboxRealtime } from '@/lib/realtime/useInboxRealtime';

/**
 * Mounts the inbox's socket. Usage: `<InboxRealtime isEnabled conversationId={…} />`,
 * once, on the inbox route.
 *
 * Renders nothing. It exists so the `'use client'` boundary is a leaf rather
 * than the page — everything else on this route stays a Server Component, which
 * is what keeps the thread's markup off the client bundle.
 *
 * `isEnabled` is decided by the server render, because the fixture transport has
 * no socket server behind it and a console reading fixtures should not spend the
 * page's first seconds retrying a connection that cannot exist.
 */
export function InboxRealtime({
  isEnabled,
  conversationId,
}: {
  isEnabled: boolean;
  conversationId: string | null;
}) {
  useInboxRealtime({ isEnabled, conversationId });

  return null;
}
