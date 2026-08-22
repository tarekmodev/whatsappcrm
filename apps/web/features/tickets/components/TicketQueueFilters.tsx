import { TICKET_PRIORITIES, TICKET_STATUSES } from '@whatsappcrm/contracts';
import { ActiveFilterChips, type ActiveFilterChip } from '@/components/ui/ActiveFilterChips';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterMenu } from '@/components/ui/FilterMenu';
import { FilterPills, type FilterPillItem } from '@/components/ui/FilterPills';
import { content } from '@/content/en';
import {
  routes,
  TICKET_SCOPES,
  TICKET_SCOPES_WITHOUT_READ_ALL,
  type TicketQueueQuery,
  type TicketScope,
} from '@/lib/routes';
import type { TicketQueueParams } from '@/features/tickets/ticket-params';

/**
 * Scope, status, priority and SLA for the queue. Usage:
 * `<TicketQueueFilters params={params} canReadAll={…} />`.
 *
 * Four groups, so 0001's filter row shows one and hides three (TAR-516): the
 * **scope** is the queue's primary question and stays as pills, while status,
 * priority and SLA sit behind one "Filters" trigger carrying a count. Before
 * this the four groups were seventeen pills across four labelled rows, which is
 * more filter than queue on a laptop and pushed the table below the fold.
 *
 * The chips beneath say which of the hidden three are on, and each one clears
 * itself — a count alone tells an agent the list is narrowed without telling
 * them by what.
 *
 * Everything is still links, so the whole bar is server rendered, ships no
 * JavaScript of its own beyond the disclosure, and puts every filter in the URL.
 * `FilterPills` renders nothing for a strip with fewer than two entries, so an
 * agent without `ticket:read_all` sees two scopes rather than a dead third.
 */

export interface TicketQueueFiltersProps {
  params: TicketQueueParams;
  /** Widens the scope strip: `unassigned` is a supervisor's view (ADR 0006 §6). */
  canReadAll: boolean;
}

export function TicketQueueFilters({ params, canReadAll }: TicketQueueFiltersProps) {
  const chips = activeChips(params);

  return (
    <FilterBar
      label={content.tickets.filtersLabel}
      chips={
        <ActiveFilterChips
          label={content.common.activeFilters}
          items={chips}
          clearAllHref={routes.tickets({ scope: params.scope })}
        />
      }
    >
      <FilterPills
        label={content.tickets.scopeFilterLabel}
        items={scopeItems(params, canReadAll)}
      />

      <FilterMenu activeCount={chips.length}>
        <FilterPills
          isLabelVisible
          label={content.tickets.statusFilterLabel}
          items={statusItems(params)}
        />
        <FilterPills
          isLabelVisible
          label={content.tickets.priorityFilterLabel}
          items={priorityItems(params)}
        />
        <FilterPills isLabelVisible label={content.sla.filterLabel} items={slaItems(params)} />
      </FilterMenu>
    </FilterBar>
  );
}

/**
 * The hidden groups that are narrowing the queue, in the order they appear in
 * the menu. Scope is never a chip: it is always visible and always set, so a
 * chip for it would be a control that cannot be cleared.
 */
function activeChips(params: TicketQueueParams): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];

  if (params.status !== undefined) {
    chips.push({
      id: 'status',
      group: content.tickets.statusFilterLabel,
      value: content.ticketStatuses[params.status],
      clearHref: href(params, { status: undefined }),
    });
  }

  if (params.priority !== undefined) {
    chips.push({
      id: 'priority',
      group: content.tickets.priorityFilterLabel,
      value: content.ticketPriorities[params.priority],
      clearHref: href(params, { priority: undefined }),
    });
  }

  if (params.isOverdueOnly) {
    chips.push({
      id: 'sla',
      group: content.sla.filterLabel,
      value: content.sla.filterOverdue,
      clearHref: href(params, { isOverdueOnly: false }),
    });
  }

  return chips;
}

const SCOPE_LABELS: Record<TicketScope, string> = {
  assigned: content.tickets.scopeAssigned,
  unassigned: content.tickets.scopeUnassigned,
  all: content.tickets.scopeAll,
};

function scopeItems(params: TicketQueueParams, canReadAll: boolean): FilterPillItem[] {
  const scopes = canReadAll ? TICKET_SCOPES : TICKET_SCOPES_WITHOUT_READ_ALL;

  return scopes.map((scope) => ({
    id: `scope-${scope}`,
    label: SCOPE_LABELS[scope],
    href: href(params, { scope }),
    isCurrent: params.scope === scope,
  }));
}

/**
 * "Active" is the absence of a `status` parameter, not a value of it: the API's
 * default is `open` and `pending` together, and that default is what makes a
 * resolved ticket leave the queue without the console asking it to.
 */
function statusItems(params: TicketQueueParams): FilterPillItem[] {
  return [
    {
      id: 'status-active',
      label: content.tickets.filterActive,
      href: href(params, { status: undefined }),
      isCurrent: params.status === undefined,
    },
    ...TICKET_STATUSES.map((status) => ({
      id: `status-${status}`,
      label: content.ticketStatuses[status],
      href: href(params, { status }),
      isCurrent: params.status === status,
    })),
  ];
}

function priorityItems(params: TicketQueueParams): FilterPillItem[] {
  return [
    {
      id: 'priority-all',
      label: content.common.all,
      href: href(params, { priority: undefined }),
      isCurrent: params.priority === undefined,
    },
    ...TICKET_PRIORITIES.map((priority) => ({
      id: `priority-${priority}`,
      label: content.ticketPriorities[priority],
      href: href(params, { priority }),
      isCurrent: params.priority === priority,
    })),
  ];
}

/**
 * Two pills rather than a checkbox, so the whole bar stays one kind of control
 * and the filter stays a link — which is what puts it in the URL and makes a
 * supervisor's "everything that has breached" view something they can send
 * somebody (TAR-26).
 */
function slaItems(params: TicketQueueParams): FilterPillItem[] {
  return [
    {
      id: 'sla-any',
      label: content.common.all,
      href: href(params, { isOverdueOnly: false }),
      isCurrent: !params.isOverdueOnly,
    },
    {
      id: 'sla-overdue',
      label: content.sla.filterOverdue,
      href: href(params, { isOverdueOnly: true }),
      isCurrent: params.isOverdueOnly,
    },
  ];
}

/**
 * The current view with one filter replaced, so changing a status keeps the
 * scope and the priority the agent had chosen.
 */
function href(params: TicketQueueParams, override: Partial<TicketQueueQuery>): string {
  return routes.tickets({ ...params, ...override });
}
