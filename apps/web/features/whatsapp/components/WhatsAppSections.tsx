import { Stack } from '@/components/layout/Stack';
import { SectionCard } from '@/components/ui/SectionCard';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { content } from '@/content/en';
import { WhatsAppConnectWizardSkeleton } from './WhatsAppConnectWizard.Skeleton';
import { LazyWhatsAppConnectWizard } from './whatsapp-widgets.lazy';

/**
 * The WhatsApp settings page's sections. One for now — the connect wizard — with
 * the frame and the heading owned here rather than in the page, so the page stays
 * composition only and the skeleton below reuses the identical frame.
 *
 * The natural second section is the accounts already connected to this workspace.
 * It is missing because the endpoint is: the API publishes `POST
 * /api/v1/whatsapp/business-accounts` and no tenant-facing `GET`, so the console
 * can show what a connection just produced and cannot list what was connected
 * yesterday. TAR-814's wizard is what that gap now costs — it resumes from a
 * cache in `sessionStorage` rather than from a read, and says so on screen.
 * When the endpoint lands, the wizard's first step derives its status from it
 * instead and this section gains the list beside it.
 *
 * `deferUntilVisible` is deliberately off: this wizard is the page's only content
 * and sits at the top of it, so there is no scroll to wait for and waiting would
 * only make the first step late.
 */
export function WhatsAppSections() {
  return (
    <Stack gap="5">
      <SectionCard
        id="whatsapp-connection"
        title={content.whatsapp.wizard.heading}
        description={content.whatsapp.wizard.description}
      >
        <LazyBoundary fallback={<WhatsAppConnectWizardSkeleton />}>
          <LazyWhatsAppConnectWizard />
        </LazyBoundary>
      </SectionCard>
    </Stack>
  );
}

/**
 * Mirrors `WhatsAppSections` — same stack, same card, same wizard skeleton — so
 * the route's `loading.tsx` hands over without the card changing height.
 *
 * Changed in the same commit as the component it stands in for.
 */
export function WhatsAppSectionsSkeleton() {
  return (
    <Stack gap="5">
      <SectionCard
        title={content.whatsapp.wizard.heading}
        description={content.whatsapp.wizard.description}
      >
        <WhatsAppConnectWizardSkeleton />
      </SectionCard>
    </Stack>
  );
}
