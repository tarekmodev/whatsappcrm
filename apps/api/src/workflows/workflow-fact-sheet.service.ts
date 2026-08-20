import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessHoursSchema, isWithinBusinessHours } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import type { WorkflowFacts, WorkflowFactsNeeded } from './workflow-facts';
import { WorkflowTicketNotVisibleError } from './workflows.errors';

/**
 * One read of everything the conditions can ask about a ticket — 0009's "fact
 * sheet", loaded once per job and **lazily**.
 *
 * ## Lazily is the whole design, not an optimisation
 *
 * 0009's access-patterns table commits to it: a workflow whose conditions are
 * all `ticket_status` reads the ticket row and nothing else, and a job whose
 * every claim conflicted reads nothing at all. Evaluation happens once per
 * triggering occurrence across the tenant's whole active set for that trigger,
 * so a fact sheet that eagerly loaded tags and business hours would put three
 * queries on every ticket creation in the platform for the benefit of the
 * tenants who happen to use those conditions.
 *
 * ## The clock is Postgres's, never the node's
 *
 * `ageMinutes` is computed from `now()` inside the same statement that reads the
 * row, for the reason 0006 states and this feature inherits: skew between API
 * instances must not be able to make a four-hour threshold true at three hours
 * fifty-nine on one replica and not on another. It is also why `ticket_age` and
 * the elapsed trigger cannot disagree — both are the same server clock.
 */
@Injectable()
export class WorkflowFactSheetService {
  private readonly logger = new Logger(WorkflowFactSheetService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The ticket's own columns plus its age, or `WorkflowTicketNotVisibleError`.
   *
   * `$queryRaw` rather than `findUnique` for one reason: `EXTRACT(EPOCH FROM
   * (now() - created_at))` has to be evaluated by the database. Reading
   * `created_at` and subtracting in JavaScript would reintroduce the node clock
   * this whole feature is built to avoid. The statement is fully parameterised —
   * the id is bound, never interpolated — and runs under RLS like every other
   * read here.
   */
  async load(ticketId: string, needed: WorkflowFactsNeeded): Promise<WorkflowFacts> {
    const [ticket] = await this.prisma.$queryRaw<
      {
        id: string;
        status: WorkflowFacts['status'];
        priority: WorkflowFacts['priority'];
        assignedUserId: string | null;
        assignedTeamId: string | null;
        contactId: string | null;
        ageMinutes: number;
      }[]
    >`
      SELECT t.id,
             t.status::text            AS "status",
             t.priority::text          AS "priority",
             t.assigned_user_id        AS "assignedUserId",
             t.assigned_team_id        AS "assignedTeamId",
             t.contact_id              AS "contactId",
             FLOOR(EXTRACT(EPOCH FROM (now() - t.created_at)) / 60)::int AS "ageMinutes"
        FROM tickets t
       WHERE t.id = ${ticketId}::uuid
    `;

    if (ticket === undefined) {
      throw new WorkflowTicketNotVisibleError(ticketId);
    }

    const [ticketTagIds, contactTagIds, withinBusinessHours] = await Promise.all([
      needed.ticketTags ? this.readTicketTagIds(ticketId) : EMPTY_TAG_SET,
      needed.contactTags ? this.readContactTagIds(ticket.contactId) : null,
      needed.businessHours ? this.readWithinBusinessHours() : null,
    ]);

    return {
      status: ticket.status,
      priority: ticket.priority,
      assignedUserId: ticket.assignedUserId,
      assignedTeamId: ticket.assignedTeamId,
      ageMinutes: ticket.ageMinutes,
      ticketTagIds,
      contactTagIds,
      withinBusinessHours,
    };
  }

  /**
   * Tags on the ticket. Never null — a ticket that carries none is an empty set,
   * which `match: 'none'` is legitimately true of.
   *
   * Served by `ticket_tags (tenant_id, ticket_id, tag_id)`, the unique index
   * that also makes applying a tag twice a no-op.
   */
  private async readTicketTagIds(ticketId: string): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.ticketTag.findMany({
      where: { ticketId },
      select: { tagId: true },
    });

    return new Set(rows.map((row) => row.tagId));
  }

  /**
   * Tags on the ticket's contact — the same `contact_tags` data 0007's `tag`
   * condition reads.
   *
   * **Null means "there is no contact"**, which is a different fact from "the
   * contact has no tags" and the evaluator reports it as `no_contact`. A ticket
   * created by hand has no contact, and collapsing the two would make
   * `match: 'none'` quietly true for every one of them.
   */
  private async readContactTagIds(contactId: string | null): Promise<ReadonlySet<string> | null> {
    if (contactId === null) {
      return null;
    }

    const rows = await this.prisma.contactTag.findMany({
      where: { contactId },
      select: { tagId: true },
    });

    return new Set(rows.map((row) => row.tagId));
  }

  /**
   * Whether *now* is inside the tenant's opening hours, or `null` when the
   * question cannot be answered.
   *
   * `isWithinBusinessHours` from 0007, unchanged, and the fail-false rule with
   * it: no configured hours, hours that do not parse, or a timezone this runtime
   * does not know all return `null`, and the condition is then false whichever
   * way `within` is set. The alternative — treating an unconfigured tenant as
   * always open or always closed — makes one of the two natural rules fire on
   * every ticket for a tenant that never configured anything.
   *
   * Against *now* rather than the ticket's `created_at`, which is where this
   * differs from routing and differs on purpose: a routing rule decides where a
   * ticket goes at the moment it arrives, while a workflow asks "is it out of
   * hours **now**, as I am about to escalate". A four-hour-old ticket breaching
   * at 02:00 is out of hours even though it arrived at 22:00.
   */
  private async readWithinBusinessHours(): Promise<boolean | null> {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId: this.tenantContext.requireTenantId() },
      select: { businessHours: true, timezone: true },
    });

    if (settings?.businessHours == null) {
      return null;
    }

    const hours = BusinessHoursSchema.safeParse(settings.businessHours);

    if (!hours.success) {
      // Once per run, naming no tenant data — 0009's failure-modes table asks
      // for exactly this line.
      this.logger.warn(
        'Tenant business hours do not parse; business_hours conditions will not match.',
      );
      return null;
    }

    try {
      return isWithinBusinessHours(hours.data, settings.timezone, new Date());
    } catch {
      this.logger.warn(
        `Tenant timezone ${settings.timezone} is not a zone this runtime knows; ` +
          'business_hours conditions will not match.',
      );
      return null;
    }
  }
}

const EMPTY_TAG_SET: ReadonlySet<string> = new Set<string>();
