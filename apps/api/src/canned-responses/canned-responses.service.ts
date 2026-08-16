import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CANNED_RESPONSE_LIMITS,
  type CannedResponseCreateInput,
  type CannedResponseListResponse,
  type CannedResponseResponse,
  type CannedResponseUpdateInput,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  CANNED_RESPONSE_CHANGED_EVENT,
  type CannedResponseChangedEvent,
} from '../events/domain-events';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  CANNED_RESPONSE_PROJECTION,
  toCannedResponseResponse,
  type CannedResponseRow,
} from './canned-response.mapper';
import {
  CannedResponseNotFoundError,
  CannedResponseShortcutTakenError,
  TooManyCannedResponsesError,
} from './canned-responses.errors';

/**
 * Ascending `shortcut`, everywhere the set is read. `shortcut` is `citext` and
 * `UNIQUE (tenant_id, shortcut)` leads with `tenant_id`, so that index serves
 * this sort and the list needs none of its own (0011, access patterns).
 */
const SHORTCUT_ORDER = {
  shortcut: 'asc',
} as const satisfies Prisma.CannedResponseOrderByWithRelationInput;

/**
 * The tenant's shared canned-response library (TAR-31), ruled by
 * `docs/architecture/0011-canned-responses-contract.md`.
 *
 * Everything runs on `TenantPrisma`, so every statement carries the
 * `app.tenant_id` GUC and is filtered by TAR-48's row-level security. The
 * service takes no tenant id from a caller — there is no parameter for one —
 * which is what makes "no cross-tenant read or write under any role" a property
 * of the wiring rather than of remembering to add a filter.
 *
 * A canned response is tenant *configuration*, not an assignable record:
 * everyone holding `canned_response:read` sees all of them, and the visibility
 * predicate that scopes conversations and tickets to their assignee does not
 * apply. Isolation is the tenant boundary alone.
 *
 * ## Where the typed shortcut is resolved
 *
 * Not here. 0011 decision 1 puts resolution in the console, against its copy of
 * the whole set, and rejects a per-token lookup endpoint on purpose: a lookup
 * that answers only once the agent has finished typing cannot drive a picker, so
 * the console would need the list as well — two readers of the same data, one of
 * them a request on the keystroke path. {@link list} returning the whole
 * bounded set, bodies included, is what satisfies TAR-477's shortcut-lookup
 * criterion.
 *
 * ## Every write announces itself after it commits
 *
 * `canned_response.changed` on the in-process bus, and only when a column
 * actually moved. TAR-485 is the subscriber that turns it into a socket event;
 * until then this is a producer with no consumer, exactly as `ticket.updated`
 * was — which is what makes that relay a subscriber away rather than a rewrite.
 */
@Injectable()
export class CannedResponsesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The whole set, by shortcut.
   *
   * Unpaginated, which is 0002's deviation for this resource and has a reason
   * (0011, decision 1): the console matches a typed token against the set
   * locally, so it needs all of it, and `perTenant` enforced on create is what
   * makes a bounded response a promise the server can keep. `nextCursor` stays
   * in the shape and stays null, so a generic list client works unchanged and
   * pagination is addable without a breaking change.
   */
  async list(): Promise<CannedResponseListResponse> {
    const rows = await this.prisma.cannedResponse.findMany({
      select: CANNED_RESPONSE_PROJECTION,
      orderBy: SHORTCUT_ORDER,
      // One over the cap, so a set that somehow exceeded it is visible as a
      // fault rather than silently truncated to look complete.
      take: CANNED_RESPONSE_LIMITS.perTenant + 1,
    });

    return { items: rows.map(toCannedResponseResponse), nextCursor: null };
  }

  async get(cannedResponseId: string): Promise<CannedResponseResponse> {
    const row = await this.prisma.cannedResponse.findUnique({
      where: { id: cannedResponseId },
      select: CANNED_RESPONSE_PROJECTION,
    });

    if (row === null) {
      throw new CannedResponseNotFoundError(cannedResponseId);
    }

    return toCannedResponseResponse(row);
  }

  async create(input: CannedResponseCreateInput): Promise<CannedResponseResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const createdByUserId = this.tenantContext.requirePrincipal().userId;

    const row = await this.prisma.$tenantTransaction(async (tx) => {
      await assertUnderCap(tx);

      const created = await tx.cannedResponse
        .create({
          data: {
            tenantId,
            shortcut: input.shortcut,
            title: input.title,
            body: input.body,
            createdByUserId,
          },
          select: CANNED_RESPONSE_PROJECTION,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error)
            ? new CannedResponseShortcutTakenError(input.shortcut)
            : error;
        });

      await this.recordChange(tx, AUDIT_ACTIONS.cannedResponseCreated, created);

      return created;
    });

    this.announce(row.id, 'saved');

    return toCannedResponseResponse(row);
  }

  /**
   * Partial update.
   *
   * **A patch that moves no column writes nothing, audits nothing and announces
   * nothing**, on `TicketUpdatedEvent`'s precedent: a broadcast that says
   * nothing is still a broadcast, and it would cost every console on the tenant
   * a refetch. The response is the row as it stands, so a client cannot tell the
   * no-op from a write that happened to produce the same values.
   */
  async update(
    cannedResponseId: string,
    input: CannedResponseUpdateInput,
  ): Promise<CannedResponseResponse> {
    const { row, changed } = await this.prisma.$tenantTransaction(async (tx) => {
      const before = await tx.cannedResponse.findUnique({
        where: { id: cannedResponseId },
        select: CANNED_RESPONSE_PROJECTION,
      });

      if (before === null) {
        throw new CannedResponseNotFoundError(cannedResponseId);
      }

      if (!movesAnything(before, input)) {
        return { row: before, changed: false };
      }

      const updated = await tx.cannedResponse
        .update({
          where: { id: cannedResponseId },
          data: {
            ...(input.shortcut === undefined ? {} : { shortcut: input.shortcut }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
          select: CANNED_RESPONSE_PROJECTION,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) && input.shortcut !== undefined
            ? new CannedResponseShortcutTakenError(input.shortcut)
            : error;
        });

      await this.recordChange(tx, AUDIT_ACTIONS.cannedResponseUpdated, updated);

      return { row: updated, changed: true };
    });

    if (changed) {
      this.announce(row.id, 'saved');
    }

    return toCannedResponseResponse(row);
  }

  /**
   * `204`, and idempotent: deleting an already-deleted response succeeds, on the
   * assignment-rules precedent. It writes no audit row and announces nothing
   * when there was nothing to delete.
   *
   * Nothing references a canned response — the body is copied into a draft at
   * insertion time and the message that was sent is its own row — so there is
   * nothing to clear first.
   */
  async delete(cannedResponseId: string): Promise<void> {
    const deleted = await this.prisma.$tenantTransaction(async (tx) => {
      const row = await tx.cannedResponse.findUnique({
        where: { id: cannedResponseId },
        select: CANNED_RESPONSE_PROJECTION,
      });

      if (row === null) {
        return false;
      }

      await tx.cannedResponse.delete({ where: { id: cannedResponseId } });
      await this.recordChange(tx, AUDIT_ACTIONS.cannedResponseDeleted, row);

      return true;
    });

    if (deleted) {
      this.announce(cannedResponseId, 'deleted');
    }
  }

  private async recordChange(
    tx: Prisma.TransactionClient,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    row: CannedResponseRow,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      targetType: 'canned_response',
      targetId: row.id,
      // The shortcut and the title, never the body: a body is free-form copy
      // that can carry customer-specific detail, and `audit_logs` is exported
      // for compliance review rather than being a place to discover it. Same
      // reasoning as `assignment_rule.*` and its conditions.
      metadata: { shortcut: row.shortcut, title: row.title },
    });
  }

  /**
   * Tells the in-process bus a canned response was written, **after** the
   * transaction has committed — announcing a change a rollback then un-wrote is
   * the failure every other producer of these events avoids the same way.
   *
   * Ids, not the resource: the payload a socket publishes must be the committed
   * row rather than the writer's view of it, so TAR-485's relay reads it back in
   * its own tenant scope.
   */
  private announce(cannedResponseId: string, change: CannedResponseChangedEvent['change']): void {
    const event: CannedResponseChangedEvent = {
      tenantId: this.tenantContext.requireTenantId(),
      cannedResponseId,
      change,
    };

    this.events.emit(CANNED_RESPONSE_CHANGED_EVENT, event);
  }
}

/**
 * Whether the patch actually moves a column.
 *
 * An absent field and a field set to the value the row already holds are the
 * same thing here, deliberately: both mean "nothing to write", and a shape that
 * distinguished them would invite a caller to announce the second.
 */
function movesAnything(before: CannedResponseRow, input: CannedResponseUpdateInput): boolean {
  return (
    (input.shortcut !== undefined && input.shortcut !== before.shortcut) ||
    (input.title !== undefined && input.title !== before.title) ||
    (input.body !== undefined && input.body !== before.body)
  );
}

/**
 * The cap is checked, then the row is written, so two creates racing at the
 * boundary can both pass and leave the tenant one response over. Accepted rather
 * than locked, on `assertUnderRuleCap`'s reasoning: the consequence is a 201st
 * row on a bound that exists to keep the unpaginated list honest, not a
 * correctness failure, and an advisory lock on a write a supervisor makes a few
 * times a month would be a heavier mechanism than the risk deserves.
 */
async function assertUnderCap(tx: Prisma.TransactionClient): Promise<void> {
  const held = await tx.cannedResponse.count();

  if (held >= CANNED_RESPONSE_LIMITS.perTenant) {
    throw new TooManyCannedResponsesError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
