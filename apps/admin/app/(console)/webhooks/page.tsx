import type { Metadata } from 'next';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import { content } from '~/content/en';
import { WebhookReplayForm } from '~/features/webhooks/components/WebhookReplayForm';

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
  title: content.webhooks.title,
};

export default function WebhooksPage() {
  return (
    <PageShell>
      <PageHeader title={content.webhooks.title} />
      <SectionErrorBoundary>
        <WebhookReplayForm />
      </SectionErrorBoundary>
    </PageShell>
  );
}
