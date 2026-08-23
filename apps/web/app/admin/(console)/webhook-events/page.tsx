import type { Metadata } from 'next';
import { content } from '@/content/en';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import { WebhookReplayForm } from '@/features/platform-admin/components/WebhookReplayForm';

/**
 * Replaying a parked inbound event. Composition only.
 *
 * No Suspense and no skeleton, because there is nothing to wait for: the screen
 * reads nothing on the server. `POST /admin/webhook-events/{id}/replay` is the
 * only route the controller publishes, so the whole surface is a form and the
 * report it produces — and a placeholder for a form whose fields are already
 * known would be a shimmer standing in for itself.
 */

export const metadata: Metadata = {
  title: content.platformAdmin.webhookEvents.title,
  description: content.platformAdmin.webhookEvents.subtitle,
};

export default function PlatformAdminWebhookEventsPage() {
  return (
    <PageShell>
      <PageHeader
        title={content.platformAdmin.webhookEvents.title}
        subtitle={content.platformAdmin.webhookEvents.subtitle}
      />
      <SectionErrorBoundary>
        <WebhookReplayForm />
      </SectionErrorBoundary>
    </PageShell>
  );
}
