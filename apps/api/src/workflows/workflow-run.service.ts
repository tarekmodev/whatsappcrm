import { Inject, Injectable } from '@nestjs/common';
import type {
  CursorPage,
  WorkflowAction,
  WorkflowRunListQuery,
  WorkflowRunResponse,
  WorkflowTestInput,
  WorkflowTestResponse,
} from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { evaluateConditions } from './workflow-conditions';
import { factsNeededBy, type WorkflowFacts } from './workflow-facts';
import { WorkflowFactSheetService } from './workflow-fact-sheet.service';
import {
  readDefinition,
  referenceKey,
  toWorkflowRunResponse,
  WORKFLOW_PROJECTION,
  WORKFLOW_RUN_PROJECTION,
  type ReferenceNames,
} from './workflow.mapper';
import { WorkflowService } from './workflow.service';
import {
  InvalidWorkflowCursorError,
  WorkflowNotFoundError,
  WorkflowTestTicketNotFoundError,
} from './workflows.errors';

/**
 * What a workflow did, and what it would do — the two read surfaces a supervisor
 * debugs with.
 *
 * 0009 is explicit about the order to use them in: **when a workflow looks
 * wrong, `GET /workflows/{id}/runs` is the first thing to read, before the
 * definition.** It says whether the workflow ran, which conditions held and what
 * each action did. The dry run is the second.
 */
@Injectable()
export class WorkflowRunService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly workflows: WorkflowService,
    private readonly facts: WorkflowFactSheetService,
  ) {}

  /**
   * One workflow's runs, newest first, keyset paginated on
   * `(created_at DESC, id DESC)`.
   *
   * **This list paginates and the workflow list does not**, and the asymmetry is
   * the point: workflows are capped per tenant, so an unbounded response is a
   * promise the server can keep, while runs grow with ticket volume × active
   * workflows and are exactly the unbounded set 0002's pagination rule exists
   * for. Served by `workflow_runs (tenant_id, workflow_id, created_at DESC,
   * id DESC)`, which carries the filter and the sort in one index.
   */
  async list(
    workflowId: string,
    query: WorkflowRunListQuery,
  ): Promise<CursorPage<WorkflowRunResponse>> {
    // A run list for a workflow the caller cannot see is `not_found` on the
    // workflow, never an empty page: an empty page would confirm nothing, but it
    // would also be indistinguishable from a workflow that has never fired,
    // which is the question the caller is asking.
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { id: true },
    });

    if (workflow === null) {
      throw new WorkflowNotFoundError(workflowId);
    }

    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidWorkflowCursorError('cursor');
    }

    const rows = await this.prisma.workflowRun.findMany({
      where: {
        workflowId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: WORKFLOW_RUN_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toWorkflowRunResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * The dry run: evaluate this workflow's conditions against a real ticket's
   * real fact sheet, and report what **would** happen.
   *
   * **It writes nothing** — no `workflow_runs` row, no ticket write, no
   * notification, no socket. Deliberately not "run it for real once": a
   * supervisor testing a rule that closes tickets should not close one, and
   * there is no way to un-close it. The rejected shape — a `commit: boolean` on
   * this endpoint — is one typo away from a live write on a surface whose whole
   * purpose is safety.
   *
   * ## `ticket:read_all` is checked here, on the named ticket
   *
   * The route requires `workflow:write`, which is supervisor-and-above, and
   * supervisors hold `ticket:read_all` under today's matrix. 0009 requires this
   * to be **checked rather than assumed**, because the permission table is data
   * and could change underneath the assumption — and reporting "condition held:
   * assigned to Sara" against a ticket the caller cannot open would be a
   * read-scope bypass. A caller without it gets `not_found`, never `forbidden`,
   * which would confirm the ticket exists.
   */
  async test(workflowId: string, input: WorkflowTestInput): Promise<WorkflowTestResponse> {
    const row = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: WORKFLOW_PROJECTION,
    });

    if (row === null) {
      throw new WorkflowNotFoundError(workflowId);
    }

    if (!this.tenantContext.requirePrincipal().permissions.includes('ticket:read_all')) {
      throw new WorkflowTestTicketNotFoundError(input.ticketId);
    }

    const definition = readDefinition(row);
    const facts = await this.loadFacts(input.ticketId, definition.conditions);
    const verdicts = evaluateConditions(definition.conditions, facts);
    const matched = verdicts.every((verdict) => verdict.held);
    const names = await this.workflows.resolveReferences([row]);

    return {
      matched,
      conditions: verdicts.map((verdict, index) => ({
        index,
        // Safe: `verdicts` is built by mapping over the same array.
        type: definition.conditions[index]?.type ?? 'ticket_status',
        held: verdict.held,
        reason: verdict.unreadable,
      })),
      // Empty when nothing matched — there is nothing to describe, and listing
      // actions beside `matched: false` invites the reader to think they ran.
      actions: matched
        ? definition.actions.map((action, index) => ({
            index,
            type: action.type,
            outcome: wouldChangeAnything(action, facts) ? ('applied' as const) : ('no_op' as const),
            describes: describeAction(action, names),
          }))
        : [],
    };
  }

  private async loadFacts(
    ticketId: string,
    conditions: Parameters<typeof factsNeededBy>[0],
  ): Promise<WorkflowFacts> {
    try {
      // Everything the conditions need, plus the two the action preview reads:
      // a dry run that could not say "this tag is already on the ticket" would
      // be reporting a different answer from the one the real run gives.
      const needed = factsNeededBy(conditions);

      return await this.facts.load(ticketId, { ...needed, ticketTags: true });
    } catch {
      // Any failure to read the ticket is `not_found` on the ticket, which is
      // the same answer a ticket in another tenant gets under RLS.
      throw new WorkflowTestTicketNotFoundError(ticketId);
    }
  }
}

/**
 * Whether the action would change anything, given what the ticket looks like
 * now.
 *
 * `applied` here means "would apply" and `no_op` means "the ticket is already in
 * that state" — the same distinction the real run records, computed from the
 * same fact sheet so the two cannot disagree. `reassign` and `notify` are always
 * reported as `applied`: the first is a last-writer-wins column this preview
 * would have to re-derive the assignment rules to predict, and the second always
 * writes a row when it has an audience.
 */
function wouldChangeAnything(action: WorkflowAction, facts: WorkflowFacts): boolean {
  switch (action.type) {
    case 'set_status':
      return action.status !== facts.status;
    case 'set_priority':
      return action.priority !== facts.priority;
    case 'add_ticket_tag':
      return !facts.ticketTagIds.has(action.tagId);
    case 'reassign':
    case 'notify':
      return true;
  }
}

/**
 * The human-readable sentence the console renders, with taxonomy ids resolved to
 * names — `Reassign to team "Escalations"`.
 *
 * Resolved from the same map the workflow response uses, so a reference that is
 * broken reads as broken here too rather than as a bare uuid.
 */
function describeAction(action: WorkflowAction, names: ReferenceNames): string {
  const named = (kind: 'tag' | 'team' | 'user', id: string): string => {
    const name = names.get(referenceKey(kind, id));

    return name === undefined ? `a ${kind} that no longer exists` : `"${name}"`;
  };

  switch (action.type) {
    case 'add_ticket_tag':
      return `Tag the ticket ${named('tag', action.tagId)}`;
    case 'reassign':
      return action.target.kind === 'team'
        ? `Reassign to team ${named('team', action.target.teamId)}`
        : `Reassign to ${named('user', action.target.userId)}`;
    case 'notify':
      switch (action.audience) {
        case 'supervisors':
          return "Notify the ticket-holder's supervisors";
        case 'user':
          return `Notify ${action.userId === null ? 'nobody' : named('user', action.userId)}`;
        case 'team':
          return `Notify team ${action.teamId === null ? 'nobody' : named('team', action.teamId)}`;
      }
    // eslint-disable-next-line no-fallthrough -- every `notify` audience returns above.
    case 'set_status':
      return `Set the status to ${action.status}`;
    case 'set_priority':
      return `Set the priority to ${action.priority}`;
  }
}

/** The resume predicate 0002 rules, on `created_at` descending. */
function resumeFrom(cursor: TimestampCursor): Prisma.WorkflowRunWhereInput {
  const { bound, exclude } = resumeAfter(cursor, 'desc');

  return { createdAt: bound, NOT: { createdAt: cursor.at, ...exclude } };
}
