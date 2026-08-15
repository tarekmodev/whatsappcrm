import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BusinessHoursSchema,
  CustomFieldValuesSchema,
  FALLBACK_ASSIGNMENT_RESOLVER,
  RoutingConditionListSchema,
  TICKET_ACTIVE_STATUSES,
  isWithinBusinessHours,
  type FallbackAssignmentDecision,
  type RoutingCondition,
  type RoutingTarget,
  type TicketRouter,
  type TicketRoutingResult,
  type TicketRoutingSkipReason,
  type TicketRoutingTrigger,
  type FallbackAssignmentResolver,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { toRoutingTarget } from './assignment-rule.mapper';
import { ruleMatches } from './rule-conditions';
import { factsNeededBy, type RoutingFacts } from './routing-facts';
import { TicketNotVisibleError } from './assignment.errors';

/** The ticket, re-read in tenant scope. Never the payload's word for any of it. */
interface RoutableTicket {
  readonly id: string;
  readonly status: string;
  readonly contactId: string | null;
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
  readonly createdAt: Date;
}

/** One active rule, with its conditions already validated against the grammar. */
interface CompiledRule {
  readonly id: string;
  readonly name: string;
  readonly conditions: readonly RoutingCondition[];
  readonly target: RoutingTarget;
}

/**
 * Routes a newly created ticket: the first matching rule wins, and rotation
 * catches everything else.
 *
 * The implementation of `TicketRouter` from `@whatsappcrm/contracts` — TAR-24's
 * evaluation engine, specified in
 * `docs/architecture/0007-routing-rules-and-assignment-fallback.md`. Driven by
 * `AssignmentQueueRunner` off the `assignment` queue; nothing calls it inline.
 *
 * ## What makes it safe to run twice, or twice at once
 *
 * Delivery is at-least-once, so idempotence cannot rest on this class checking
 * first and writing second. It rests on the write being a **compare-and-set**
 * bounded to `assigned_user_id IS NULL AND assigned_team_id IS NULL`, in the
 * same transaction as the `ticket_events` append. A redelivered job finds the
 * ticket assigned and reports `skipped`; the early check on the same columns is
 * an optimisation that saves the evaluation, not the mechanism.
 *
 * That is also the right product behaviour, not only the safe one: a supervisor
 * who assigns the ticket by hand in the second before this runs keeps their
 * assignment. A blind write would silently undo a person's decision in favour of
 * a rule.
 *
 * ## What it refuses to trust, and what it refuses to throw
 *
 * The trigger is a queue payload — unauthenticated input — so every id in it is
 * re-read through `TenantPrisma` in the scope the runner opened from
 * `job.data.tenantId`. A forged or stale job reads nothing under RLS and fails
 * loudly rather than routing one tenant's ticket by another's rules.
 *
 * Against that, **bad tenant data never throws**. A rule whose stored conditions
 * do not parse, a `business_hours` column holding something unexpected, a
 * contact that has no tags: each makes a condition false, the rule falls
 * through, and evaluation continues to the next one. The failure mode of a
 * routing engine has to be "this ticket went to rotation", never "this ticket
 * went to the wrong team" and never "the queue stopped".
 *
 * Infrastructure failure is the opposite and propagates, so BullMQ's retry
 * policy decides what happens next.
 */
@Injectable()
export class RuleEngineService implements TicketRouter {
  private readonly logger = new Logger(RuleEngineService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    @Inject(FALLBACK_ASSIGNMENT_RESOLVER) private readonly fallback: FallbackAssignmentResolver,
  ) {}

  async routeTicket(trigger: TicketRoutingTrigger): Promise<TicketRoutingResult> {
    const ticket = await this.readTicket(trigger);

    if (!isActive(ticket.status)) {
      return skipped('ticket_not_active');
    }

    if (ticket.assignedUserId !== null || ticket.assignedTeamId !== null) {
      return skipped('already_assigned');
    }

    // Every write below carries the tenant the runner put in scope, not the one
    // the payload claims. Reached only here because the read above already went
    // through `TenantPrisma`, so an unscoped call has failed with
    // `MissingTenantContextError` before this line.
    const tenantId = this.tenantContext.requireTenantId();

    const rules = await this.loadActiveRules();
    const matched =
      rules.length === 0
        ? null
        : await this.firstUsableMatch(rules, await this.facts(trigger, ticket, rules));

    return matched === null
      ? await this.fallBack(tenantId, ticket)
      : await this.applyRule(tenantId, ticket, matched);
  }

  /**
   * The ticket, in tenant scope.
   *
   * A ticket that is not there throws rather than skipping, because the
   * realistic cause is this job overtaking the transaction that created it —
   * which the next retry fixes. The other cause, a payload naming another
   * tenant's ticket, reads nothing under RLS and lands here too; failing loudly
   * is the intended outcome for both.
   */
  private async readTicket(trigger: TicketRoutingTrigger): Promise<RoutableTicket> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { tenantId_id: { tenantId: trigger.tenantId, id: trigger.ticketId } },
      select: {
        id: true,
        status: true,
        contactId: true,
        assignedUserId: true,
        assignedTeamId: true,
        createdAt: true,
      },
    });

    if (ticket === null) {
      throw new TicketNotVisibleError(trigger.ticketId);
    }

    return ticket;
  }

  /**
   * The active set, whole and in evaluation order — one query per ticket, out of
   * `(tenant_id, is_active, position, id)`.
   *
   * The set is bounded by `ROUTING_RULE_LIMITS.rulesPerTenant`, which is what
   * makes reading it whole and comparing in memory the right shape: no per-rule
   * query, and no SQL translation of the condition grammar, which is what
   * `conditions JSONB` was for.
   *
   * A rule whose stored conditions no longer parse is dropped with a warning
   * rather than failing the job. It is unreachable through the API, which
   * validates on write — but the one thing worse than a rule that does not fire
   * is a queue that stops because of it.
   */
  private async loadActiveRules(): Promise<CompiledRule[]> {
    const rows = await this.prisma.assignmentRule.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        conditions: true,
        targetUserId: true,
        targetTeamId: true,
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });

    return rows.flatMap((row) => {
      const conditions = RoutingConditionListSchema.safeParse(row.conditions);
      const target = toRoutingTarget(row);

      if (!conditions.success) {
        this.logger.warn(`Skipping rule ${row.id}: its conditions do not parse.`);
        return [];
      }

      if (target === null) {
        // The CHECK constraint makes this unreachable for an active rule.
        this.logger.warn(`Skipping rule ${row.id}: it is active with no target.`);
        return [];
      }

      return [{ id: row.id, name: row.name, conditions: conditions.data, target }];
    });
  }

  /**
   * The four sources the tenant's rules actually read, loaded once per ticket.
   *
   * A tenant whose rules are all `business_hours` touches neither the contact
   * nor the message; one with no `tag` condition never reads `contact_tags`.
   * Every one of them resolves to `null` rather than throwing when there is
   * nothing to read, because that is what makes the condition false instead of
   * failing the job.
   */
  private async facts(
    trigger: TicketRoutingTrigger,
    ticket: RoutableTicket,
    rules: readonly CompiledRule[],
  ): Promise<RoutingFacts> {
    const needed = factsNeededBy(rules.map((rule) => rule.conditions));

    const [messageBody, tagIds, customFields, withinBusinessHours] = await Promise.all([
      needed.messageBody ? this.readMessageBody(trigger) : null,
      needed.tags ? this.readTagIds(ticket) : null,
      needed.customFields ? this.readCustomFields(ticket) : null,
      // Against the ticket's own `created_at`, not the payload's — 0007 rule 3:
      // a queue payload is not evidence for anything the database can answer.
      needed.businessHours ? this.readWithinBusinessHours(ticket.createdAt) : null,
    ]);

    return { messageBody, tagIds, customFields, withinBusinessHours };
  }

  /**
   * `messages.body` of the message that opened the ticket — which is also the
   * caption on a media message, so a photo captioned "invoice" routes without a
   * fifth condition type.
   *
   * The message id is carried on the trigger rather than derived here so that a
   * `keyword` condition matches the message that actually opened the ticket, not
   * whichever message is newest by the time the worker runs.
   */
  private async readMessageBody(trigger: TicketRoutingTrigger): Promise<string | null> {
    if (trigger.messageId === null) {
      return null;
    }

    const message = await this.prisma.message.findUnique({
      where: { tenantId_id: { tenantId: trigger.tenantId, id: trigger.messageId } },
      select: { body: true },
    });

    return message?.body ?? null;
  }

  private async readTagIds(ticket: RoutableTicket): Promise<ReadonlySet<string> | null> {
    if (ticket.contactId === null) {
      return null;
    }

    const tags = await this.prisma.contactTag.findMany({
      where: { contactId: ticket.contactId },
      select: { tagId: true },
    });

    return new Set(tags.map((tag) => tag.tagId));
  }

  /**
   * The contact's `custom_fields`, where **"there is no contact" and "the contact
   * has no fields set" are different answers**.
   *
   * `null` is the first: no contact on the ticket, or no contact row visible in
   * this tenant. Every `contact_attribute` condition is false against it, on
   * 0007's "no data to read is false" rule.
   *
   * `{}` is the second, and it has to reach the evaluator as an empty object
   * rather than as `null`, because `is_not_set` is *true* of a contact who exists
   * with nothing set. The column is nullable and every contact auto-created from
   * a first inbound message leaves it null (`whatsapp-inbound.writer.ts`), so
   * conflating the two would make "`plan_tier` is not set → Onboarding" never
   * fire for a brand-new customer — the exact population that rule targets — and
   * it would only look correct when tested against a contact somebody had already
   * edited once.
   *
   * Fields that do not parse stay `null`: that is corrupt data rather than an
   * empty field, and answering `is_not_set` from it would be a guess.
   */
  private async readCustomFields(
    ticket: RoutableTicket,
  ): Promise<Readonly<Record<string, string | null>> | null> {
    if (ticket.contactId === null) {
      return null;
    }

    const contact = await this.prisma.contact.findUnique({
      where: {
        tenantId_id: { tenantId: this.tenantContext.requireTenantId(), id: ticket.contactId },
      },
      select: { customFields: true },
    });

    if (contact === null) {
      return null;
    }

    if (contact.customFields === null) {
      return {};
    }

    const parsed = CustomFieldValuesSchema.safeParse(contact.customFields);

    if (!parsed.success) {
      this.logger.warn(
        `Contact ${ticket.contactId} has custom fields that do not parse; ` +
          'contact_attribute conditions will not match.',
      );
      return null;
    }

    return parsed.data;
  }

  /**
   * `null` means the question cannot be answered, and that is not the same as
   * `false`.
   *
   * Three ways to get there: the tenant never configured hours, the column holds
   * something that is not the published shape, or the configured hours contain
   * no open interval at all. 0007 decision 3 treats all three the same way — the
   * condition is false whichever way `within` is set, so the rule does not match
   * and evaluation continues. The alternative, treating an unconfigured tenant
   * as always open or always closed, makes one of the two natural rules ("out of
   * hours, route to the on-call team") fire on every single ticket.
   */
  private async readWithinBusinessHours(at: Date): Promise<boolean | null> {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId: this.tenantContext.requireTenantId() },
      select: { businessHours: true, timezone: true },
    });

    if (settings?.businessHours == null) {
      return null;
    }

    const hours = BusinessHoursSchema.safeParse(settings.businessHours);

    if (!hours.success || !hasAnyOpenInterval(hours.data)) {
      if (!hours.success) {
        this.logger.warn(
          'Tenant business hours do not parse; business_hours conditions will not match.',
        );
      }
      return null;
    }

    try {
      return isWithinBusinessHours(hours.data, settings.timezone, at);
    } catch {
      // An unresolvable `tenant_settings.timezone`. Predates
      // `IanaTimezoneSchema` validating the column, and is not worth failing a
      // ticket's routing over.
      this.logger.warn(
        `Tenant timezone ${settings.timezone} is not a zone this runtime knows; ` +
          'business_hours conditions will not match.',
      );
      return null;
    }
  }

  /**
   * The first rule that matches **and** has a target that can do the work.
   *
   * A rule whose target is a suspended user or a team with no active members is
   * treated as not matching, and evaluation continues (0007, decision 4). The
   * alternative — assign anyway and alert — would leave the ticket invisible to
   * every role without `_all` until somebody read the alert, where skipping puts
   * it in front of rotation immediately.
   *
   * The target check is per matched rule rather than resolved for the whole set
   * up front, so the common case costs exactly one extra read: rules that match
   * are rare, and rules that match with a broken target are rarer.
   */
  private async firstUsableMatch(
    rules: readonly CompiledRule[],
    facts: RoutingFacts,
  ): Promise<CompiledRule | null> {
    for (const rule of rules) {
      if (!ruleMatches(rule.conditions, facts)) {
        continue;
      }

      if (await this.isTargetUsable(rule.target)) {
        return rule;
      }

      // Named, and worth monitoring: a rule that is skipped every time is a rule
      // its author believes is working.
      this.logger.warn(
        `Rule ${rule.id} matched but its ${rule.target.kind} target cannot take work; ` +
          'continuing to the next rule.',
      );
    }

    return null;
  }

  private async isTargetUsable(target: RoutingTarget): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();

    if (target.kind === 'user') {
      const user = await this.prisma.user.findUnique({
        where: { tenantId_id: { tenantId, id: target.userId } },
        select: { status: true },
      });

      // `removed` cannot appear: `UsersService` clears `targetUserId` and
      // deactivates every rule pointing at a removed user, inside the removal
      // transaction, so such a rule is never loaded.
      return user?.status === 'active';
    }

    const member = await this.prisma.teamMember.findFirst({
      where: { teamId: target.teamId, user: { status: 'active' } },
      select: { id: true },
    });

    return member !== null;
  }

  /**
   * A matched rule is **terminal**: it assigns its target and stops. It does not
   * then run rotation to pick a person inside the targeted team.
   *
   * TAR-24's first acceptance criterion is explicit that a matching ticket routes
   * to that team *instead of* default rotation, and a team-routed ticket is not
   * lost — it is visible to that team's members under 0004's visibility
   * predicate, with a claim path from 0002 amendment 6 for work nobody holds.
   * 0007 carries the cost as risk 1, and `FallbackAssignmentRequest.teamId`
   * already exists so that rotating within a matched team later is a call rather
   * than a redesign.
   */
  private async applyRule(
    tenantId: string,
    ticket: RoutableTicket,
    rule: CompiledRule,
  ): Promise<TicketRoutingResult> {
    const assignment = columnsFor(rule.target);

    const written = await this.assign(tenantId, ticket, assignment, {
      type: 'assigned',
      // The rule *name*, which is why the column is `citext` with a unique
      // constraint: this line is what a supervisor reads when they ask why a
      // ticket went where it did. The rule id is carried beside it so the answer
      // survives a rename.
      reason: `Routed by rule "${rule.name}"`,
      ruleId: rule.id,
    });

    return written
      ? {
          outcome: 'routed',
          ruleId: rule.id,
          assignedUserId: assignment.assignedUserId,
          assignedTeamId: assignment.assignedTeamId,
          reason: null,
        }
      : skipped('already_assigned');
  }

  /**
   * No rule matched, so the ticket goes to rotation — the one call TAR-24 makes
   * into TAR-23, and the whole of what this story does about fallback
   * assignment.
   *
   * The resolver decides and writes nothing; the assignment write stays here,
   * because it is a compare-and-set that also appends the ticket event and it is
   * the only place tenant scope has to be right.
   */
  private async fallBack(tenantId: string, ticket: RoutableTicket): Promise<TicketRoutingResult> {
    const decision = await this.fallback.resolveFallbackAssignment({
      tenantId,
      ticketId: ticket.id,
      contactId: ticket.contactId,
      // Null: no rule matched, so there is no team in mind. The field exists for
      // decision 4's rejected option, which TAR-24 does not take.
      teamId: null,
    });

    return isAssignment(decision)
      ? await this.applyRotation(tenantId, ticket, decision)
      : await this.defer(tenantId, ticket, decision);
  }

  private async applyRotation(
    tenantId: string,
    ticket: RoutableTicket,
    decision: FallbackAssignmentDecision & { userId: string },
  ): Promise<TicketRoutingResult> {
    const assignment = { assignedUserId: decision.userId, assignedTeamId: null };

    const written = await this.assign(tenantId, ticket, assignment, {
      type: 'assigned',
      reason: 'Assigned by rotation',
      ruleId: null,
    });

    return written
      ? {
          outcome: 'fallback_assigned',
          ruleId: null,
          assignedUserId: decision.userId,
          assignedTeamId: null,
          reason: null,
        }
      : skipped('already_assigned');
  }

  /**
   * Rotation had nobody. The ticket stays unassigned, the reason goes on its
   * event log, and `routing_state` is flipped to `deferred` — which is what
   * makes it a supervisor-visible state rather than a ticket that quietly
   * nobody owns. The event carries the distinction 0007 decision 5 widened the
   * return type to hold; the column is what TAR-274's
   * `?routingState=deferred` list reads, so without it the supervisor's queue
   * is permanently empty (0008 amendment 1).
   *
   * ## The column write is first-transition-only; the event is not
   *
   * `routing_state: { not: 'deferred' }` in the `WHERE` is the whole of it, and
   * it is a guard rather than a read-then-write for the same reason the
   * compare-and-set below is. `routing_deferred_since` is the supervisor's
   * ageing key: a redelivered job that reset it would make an hour-old stuck
   * ticket look like it arrived just now, and the original timestamp is not
   * recoverable. A repeat appends its event — the log is a history and a second
   * deferral did happen — and moves no column.
   *
   * The three columns move in one statement because
   * `tickets_routing_deferred_consistent` requires it: the state and its two
   * nullable companions have to agree at statement end.
   */
  private async defer(
    tenantId: string,
    ticket: RoutableTicket,
    decision: FallbackAssignmentDecision,
  ): Promise<TicketRoutingResult> {
    const reason = decision.reason ?? 'no_candidate_pool';

    await this.prisma.$tenantTransaction(async (tx) => {
      await tx.ticket.updateMany({
        where: {
          tenantId,
          id: ticket.id,
          routingState: { not: 'deferred' },
        },
        data: {
          routingState: 'deferred',
          routingDeferredReason: reason,
          routingDeferredSince: new Date(),
        },
      });

      await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          type: 'assignment_deferred',
          data: { reason },
        },
      });
    });

    return {
      outcome: 'deferred',
      ruleId: null,
      assignedUserId: null,
      assignedTeamId: null,
      reason,
    };
  }

  /**
   * The compare-and-set, and the ticket event, in one transaction.
   *
   * The `WHERE` carries the guard rather than a read preceding the write, so the
   * check and the write are one statement two workers cannot interleave. The
   * event is appended only if this transaction is the one that moved the ticket,
   * so the log never claims an assignment that did not happen.
   *
   * `tenantId` is supplied explicitly on both statements: TAR-49's extension does
   * not inject it, and RLS's `WITH CHECK` is the backstop rather than the
   * mechanism (0003, rule 3).
   *
   * `routing_state` rides along in the same `data` rather than in a second
   * statement, so both branches that reach here — a matched rule and rotation —
   * get it, and so a ticket cannot exist assigned but still reading `pending`.
   * The deferred pair is cleared rather than left: a ticket deferred earlier and
   * assigned now would otherwise carry a stale reason, and
   * `tickets_routing_deferred_consistent` would reject the row for it (0008
   * amendment 1).
   */
  private async assign(
    tenantId: string,
    ticket: RoutableTicket,
    assignment: { assignedUserId: string | null; assignedTeamId: string | null },
    event: { type: string; reason: string; ruleId: string | null },
  ): Promise<boolean> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: {
          tenantId,
          id: ticket.id,
          assignedUserId: null,
          assignedTeamId: null,
        },
        data: {
          ...assignment,
          routingState: 'assigned',
          routingDeferredReason: null,
          routingDeferredSince: null,
        },
      });

      if (count === 0) {
        return false;
      }

      await tx.ticketEvent.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          type: event.type,
          // `actor_user_id` stays null: the actor is the system, which
          // `ticket_events` already documents as what null means.
          data: {
            reason: event.reason,
            ...(event.ruleId === null ? {} : { ruleId: event.ruleId }),
            ...assignment,
          } satisfies Prisma.InputJsonObject,
        },
      });

      return true;
    });
  }
}

/** A user target sets one column and leaves the other null; a team does the reverse. */
function columnsFor(target: RoutingTarget): {
  assignedUserId: string | null;
  assignedTeamId: string | null;
} {
  return target.kind === 'user'
    ? { assignedUserId: target.userId, assignedTeamId: null }
    : { assignedUserId: null, assignedTeamId: target.teamId };
}

/**
 * A decision is an assignment only if it also names somebody. The contract says
 * `userId` is non-null exactly when the outcome is `assigned`; this is what
 * keeps a resolver that breaks its own invariant from writing a null assignment
 * that reads as "routed".
 */
function isAssignment(
  decision: FallbackAssignmentDecision,
): decision is FallbackAssignmentDecision & { userId: string } {
  return decision.outcome === 'assigned' && decision.userId !== null;
}

function isActive(status: string): boolean {
  return TICKET_ACTIVE_STATUSES.some((active) => active === status);
}

/**
 * `{}` — and a record whose every day is an empty array — is a tenant that is
 * never open, and 0007 puts it in the same bucket as hours that were never
 * configured: the condition is false either way rather than matching
 * `within: false` on every ticket.
 */
function hasAnyOpenInterval(hours: Record<string, readonly unknown[] | undefined>): boolean {
  return Object.values(hours).some((intervals) => (intervals?.length ?? 0) > 0);
}

function skipped(reason: TicketRoutingSkipReason): TicketRoutingResult {
  return {
    outcome: 'skipped',
    ruleId: null,
    assignedUserId: null,
    assignedTeamId: null,
    reason,
  };
}
