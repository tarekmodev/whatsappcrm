import type { AdminDomainStatus } from '@whatsappcrm/contracts';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { content } from '~/content/en';
import { attemptRead } from '~/lib/attempt-read';
import { listDomainQueue } from '~/lib/api/admin';
import { CredentialRefused } from '~/features/shell/components/CredentialRefused';
import { DOMAIN_STATUS_DEFAULT } from '~/lib/routes';
import { domainQueueHref } from '../domain-queue';
import { DomainQueueFilter } from './DomainQueueFilter';
import { DomainQueueTable } from './DomainQueueTable';

/**
 * The domain queue, read on the server (spec §2.3 region 2, §2.8).
 *
 * The card frame, the filter and the count are owned here rather than in the
 * page, which is what lets the skeleton beside this file reuse the identical
 * frame — and what lets the same section render on the Tenants screen and on
 * `/domains` without a second copy.
 */
export async function DomainQueueSection({
  status,
  isTitleVisible = true,
}: {
  status: AdminDomainStatus;
  /**
   * False on `/domains`, where `PageHeader` already says "Domains" and a card
   * titled "Domain queue" under it is the same thing said twice (spec §2.3). On
   * `/tenants` the title earns its place — it names the second of two regions.
   *
   * The heading stays in the document outline and in the region's accessible
   * name either way; only the eye loses it.
   */
  isTitleVisible?: boolean;
}) {
  const queue = await attemptRead(async () => await listDomainQueue(status));

  if (queue.status === 'credential-refused') {
    return <CredentialRefused />;
  }

  // `not-found` cannot happen on a collection route; if it ever did, an empty
  // queue is the same thing to read as a queue with nothing in it.
  const domains = queue.status === 'ok' ? queue.data : [];
  const isWaiting = status === 'verified';

  return (
    <SectionCard
      id="domain-queue"
      title={content.domains.queueHeading}
      isTitleVisible={isTitleVisible}
      description={content.domains.count(domains.length)}
    >
      <Stack gap="4">
        <DomainQueueFilter status={status} />
        <Notice tone="info" variant="quiet">
          {content.domains.recordOnlyNotice}
        </Notice>
        {domains.length === 0 ? (
          <EmptyState
            icon="globe"
            title={isWaiting ? content.domains.emptyWaitingTitle : content.domains.emptyLiveTitle}
            description={
              isWaiting ? content.domains.emptyWaitingBody : content.domains.emptyLiveBody
            }
            /*
             * Two different empty states, and only one of them has a next step.
             * "Nothing is waiting" is a real empty — there is genuinely nothing to
             * do. "Nothing is attached yet" is a *filtered* view, so it offers the
             * way back; sharing one string between them is what makes a working
             * filter look broken (0001).
             */
            action={
              isWaiting ? undefined : (
                <ButtonLink href={domainQueueHref(DOMAIN_STATUS_DEFAULT)} variant="secondary">
                  {content.domains.emptyLiveAction}
                </ButtonLink>
              )
            }
          />
        ) : (
          <DomainQueueTable domains={domains} status={status} />
        )}
      </Stack>
    </SectionCard>
  );
}
