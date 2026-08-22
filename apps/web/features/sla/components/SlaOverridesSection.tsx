import type { SlaPolicyResponse } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { useContent, type Content } from '@/lib/content';
import { describeOverrideWindows } from '../window-form';

/**
 * The workspace's per-priority policies, read-only. Usage:
 * `<SlaOverridesSection overrides={overrides} hasMore={hasMore} />` — the caller
 * renders it only when there is at least one.
 *
 * ## Why they are reported rather than edited
 *
 * `resolvePolicyForPriority` prefers an active policy whose `priority` matches
 * the ticket's over the catch-all, so an override genuinely changes what a
 * supervisor sees in the queue — which is why hiding them would be dishonest.
 * But `SlaPolicyUpdateInputSchema` accepts no `priority`, and the resource has
 * no `POST`, so there is nothing this screen could offer beyond what is here:
 * per-priority policies are the API's surface at v1 and TAR-390 leaves them out
 * of scope on purpose.
 *
 * A `DetailList` rather than a table: this is a handful of term-and-value pairs
 * with no row actions, no sort and no selection, and a `<table>` for it would be
 * a grid announcing columns that carry no meaning.
 */
export function SlaOverridesSection({
  overrides,
  hasMore,
}: {
  overrides: readonly SlaPolicyResponse[];
  hasMore: boolean;
}) {
  const content = useContent();
  const copy = content.slaSettings;

  return (
    <SectionCard
      id="sla-overrides"
      title={copy.overridesHeading}
      description={copy.overridesDescription}
    >
      <Stack gap="4">
        <DetailList items={overrides.map((policy) => toItem(policy, content))} />
        <Notice tone="info" variant="quiet">
          {copy.overridesNotice}
        </Notice>
        {/* Said out loud rather than left to a truncated list: a supervisor
            reading "these are all of them" when they are not is worse than no
            list. One page holds far more than a tenant can reach today, so this
            is a guard rather than an expected state. */}
        {hasMore ? <Notice tone="warning">{copy.overridesTruncated}</Notice> : null}
      </Stack>
    </SectionCard>
  );
}

function toItem(policy: SlaPolicyResponse, content: Content): DetailListItem {
  const copy = content.slaSettings;
  // `priority` is non-null by construction — `loadSlaPolicies` puts the
  // catch-all in `defaultPolicy` and everything else here — and the fallback
  // exists because the response type says it could be null.
  const priority = policy.priority;

  return {
    id: policy.id,
    term: priority === null ? policy.name : content.ticketPriorities[priority],
    value: describeOverrideWindows(policy),
    // An inactive policy is skipped by `resolvePolicyForPriority` entirely, so
    // it decides nothing. Saying so is what stops somebody reading a window
    // that is not in force as one that is.
    hint: policy.isActive ? undefined : copy.overrideInactive,
  };
}
