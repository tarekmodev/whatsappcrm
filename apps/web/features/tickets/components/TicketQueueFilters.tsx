import { TICKET_PRIORITIES, TICKET_STATUSES } from '@whatsappcrm/contracts';
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
import styles from './TicketQueueFilters.module.css';

/**
 * Scope, status and priority for the queue. Usage:
 * `<TicketQueueFilters params={params} canReadAll={…} />`.
 *
 * Three strips of links rather than three selects, so the whole bar is server
 * rendered, ships no JavaScript, and puts every filter in the URL — a refresh, a
 * copied link and the back button all reproduce the same view. `FilterPills`
 * renders nothing for a strip with fewer than two entries, so an agent without
 * `ticket:read_all` sees two scopes rather than a dead third.
 */

export interface TicketQueueFiltersProps {
  params: TicketQueueParams;
  /** Widens the scope strip: `unassigned` is a supervisor's view (ADR 0006 §6). */
  canReadAll: boolean;
}

export function TicketQueueFilters({ params, canReadAll }: TicketQueueFiltersProps) {
  return (
    <div className={styles.bar}>
      <FilterPills
        isLabelVisible
        label={content.tickets.scopeFilterLabel}
        items={scopeItems(params, canReadAll)}
      />
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
    </div>
  );
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
 * The current view with one filter replaced, so changing a status keeps the
 * scope and the priority the agent had chosen.
 */
function href(params: TicketQueueParams, override: Partial<TicketQueueQuery>): string {
  return routes.tickets({ ...params, ...override });
}
