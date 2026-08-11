import { Stack } from '@/components/layout/Stack';
import { SectionCard } from '@/components/ui/SectionCard';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { content } from '@/content/en';
import { EmbeddedSignupPanelSkeleton } from './EmbeddedSignupPanel.Skeleton';
import { LazyEmbeddedSignupPanel } from './whatsapp-widgets.lazy';

/**
 * The WhatsApp settings page's sections. One for now — the connection panel —
 * with the frame and the heading owned here rather than in the page, so the page
 * stays composition only and the skeleton below reuses the identical frame.
 *
 * The natural second section is the accounts already connected to this workspace.
 * It is missing because the endpoint is: the API publishes `POST
 * /api/v1/whatsapp/business-accounts` and no tenant-facing `GET`, so the console
 * can show what a connection just produced and cannot list what was connected
 * yesterday. When that endpoint lands it slots in beside this one without
 * touching the page file — `ConnectedBusinessAccount` already renders the shape
 * it would return.
 *
 * `deferUntilVisible` is deliberately off: this panel is the page's only content
 * and sits at the top of it, so there is no scroll to wait for and waiting would
 * only make the button late.
 */
export function WhatsAppSections() {
  return (
    <Stack gap="5">
      <SectionCard
        id="whatsapp-connection"
        title={content.whatsapp.connectHeading}
        description={content.whatsapp.connectDescription}
      >
        <LazyBoundary fallback={<EmbeddedSignupPanelSkeleton />}>
          <LazyEmbeddedSignupPanel />
        </LazyBoundary>
      </SectionCard>
    </Stack>
  );
}

/**
 * Mirrors `WhatsAppSections` — same stack, same card, same panel skeleton — so
 * the route's `loading.tsx` hands over without the card changing height.
 *
 * Changed in the same commit as the component it stands in for.
 */
export function WhatsAppSectionsSkeleton() {
  return (
    <Stack gap="5">
      <SectionCard
        title={content.whatsapp.connectHeading}
        description={content.whatsapp.connectDescription}
      >
        <EmbeddedSignupPanelSkeleton />
      </SectionCard>
    </Stack>
  );
}
