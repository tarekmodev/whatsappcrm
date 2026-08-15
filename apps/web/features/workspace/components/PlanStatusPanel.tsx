import type { TenantLifecycleResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { UsageMeter } from '@/components/ui/UsageMeter';
import { AutoGrid } from '@/components/layout/AutoGrid';
import { Stack } from '@/components/layout/Stack';
import { useContent, type Content } from '@/lib/content';
import { readConversationUsage, readSeatUsage, type UsageReading } from '../plan-usage';
import { TENANT_STATUS_TONES } from '../presentation';

/**
 * What `GET /api/v1/tenant/lifecycle` says, rendered: the lifecycle state, the
 * plan, the dates that are pending, and the two meters. Usage:
 * `<PlanStatusPanel lifecycle={lifecycle} />`.
 *
 * A server component with no interactivity, so none of this reaches the client
 * bundle — the only client boundaries below it are the `RelativeTime` values,
 * which need a mount to phrase themselves.
 *
 * `TenantLifecycleResponse` rather than `BillingSummaryResponse`, which is the
 * distinction the contract draws and this panel depends on: the second describes
 * a subscription and a workspace on a trial has none.
 */
export function PlanStatusPanel({ lifecycle }: { lifecycle: TenantLifecycleResponse }) {
  const content = useContent();
  const seats = readSeatUsage(lifecycle);
  const conversations = readConversationUsage(lifecycle);

  return (
    <Stack gap="5">
      <DetailList items={planDetails(lifecycle, content)} />

      <AutoGrid minItemWidth="16rem" gap="5">
        <UsageMeter
          heading={content.workspace.seatsHeading}
          summary={usageSummary(seats, content, {
            capped: content.workspace.seatsUsage,
            uncapped: content.workspace.seatsUsageUnlimited,
          })}
          ratio={seats.ratio}
          tone={seats.tone}
        >
          {seatNote(lifecycle, seats, content)}
        </UsageMeter>

        <UsageMeter
          heading={content.workspace.conversationsHeading}
          summary={usageSummary(conversations, content, {
            capped: content.workspace.conversationsUsage,
            uncapped: content.workspace.conversationsUsageUnlimited,
          })}
          ratio={conversations.ratio}
          tone={conversations.tone}
        />
      </AutoGrid>

      {seats.isAtCap || conversations.isAtCap ? (
        <Notice tone="warning">{content.workspace.upgradeUnavailableNotice}</Notice>
      ) : null}
    </Stack>
  );
}

/**
 * Status and plan always; each date only when it is set.
 *
 * The dates are read rather than inferred from the status — a transition that
 * has not written its timer yet has none — so a row is never a promise about
 * when something happens that nothing has actually scheduled.
 */
function planDetails(
  lifecycle: TenantLifecycleResponse,
  content: Content,
): readonly DetailListItem[] {
  const items: DetailListItem[] = [
    {
      id: 'status',
      term: content.workspace.statusLabel,
      value: (
        <Badge tone={TENANT_STATUS_TONES[lifecycle.status]}>
          {content.workspace.statuses[lifecycle.status]}
        </Badge>
      ),
    },
    { id: 'plan', term: content.workspace.planLabel, value: lifecycle.plan.name },
  ];

  const deadlines = [
    { id: 'trial-ends-at', term: content.workspace.trialEndsLabel, at: lifecycle.trialEndsAt },
    {
      id: 'grace-period-ends-at',
      term: content.workspace.suspendsLabel,
      at: lifecycle.gracePeriodEndsAt,
    },
    { id: 'purge-at', term: content.workspace.purgeLabel, at: lifecycle.purgeAt },
  ];

  for (const deadline of deadlines) {
    if (deadline.at !== null) {
      items.push({
        id: deadline.id,
        term: deadline.term,
        value: <RelativeTime isoTimestamp={deadline.at} label={deadline.term} />,
      });
    }
  }

  return items;
}

/**
 * Numbers are formatted with `Intl` against the content module's own locale —
 * never the browser's, which would differ from the server's and produce a
 * hydration mismatch on any four-figure conversation count.
 */
function usageSummary(
  reading: UsageReading,
  content: Content,
  copy: { capped: (used: string, cap: string) => string; uncapped: (used: string) => string },
): string {
  const format = new Intl.NumberFormat(content.locale);
  const used = format.format(reading.used);

  return reading.cap === null ? copy.uncapped(used) : copy.capped(used, format.format(reading.cap));
}

/**
 * At most one line under the seat meter, and the more urgent one wins: "every
 * seat is taken" is what an admin has to act on, and repeating the outstanding
 * count under it would bury it.
 */
function seatNote(
  lifecycle: TenantLifecycleResponse,
  seats: UsageReading,
  content: Content,
): string | undefined {
  if (seats.isAtCap) {
    return content.workspace.seatsAtCapNote;
  }

  return lifecycle.usage.seatsPending === 0
    ? undefined
    : content.workspace.seatsPendingNote(lifecycle.usage.seatsPending);
}
