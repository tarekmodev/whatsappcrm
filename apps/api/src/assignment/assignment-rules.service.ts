import { Inject, Injectable } from '@nestjs/common';
import {
  ROUTING_RULE_LIMITS,
  type AssignmentRuleCreateInput,
  type AssignmentRuleListResponse,
  type AssignmentRuleReorderInput,
  type AssignmentRuleResponse,
  type AssignmentRuleUpdateInput,
  type RoutingCondition,
  type RoutingTarget,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  toAssignmentRuleResponse,
  toRoutingTarget,
  toTargetColumns,
  type AssignmentRuleRow,
} from './assignment-rule.mapper';
import {
  AssignmentRuleNameTakenError,
  AssignmentRuleNotFoundError,
  RuleNeedsTargetError,
  RuleSetChangedError,
  TooManyAssignmentRulesError,
  UnknownRuleReferenceError,
} from './assignment.errors';

const RULE_PROJECTION = {
  id: true,
  name: true,
  position: true,
  isActive: true,
  conditions: true,
  targetUserId: true,
  targetTeamId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AssignmentRuleSelect;

/**
 * Evaluation order, everywhere it is read: ascending `position`, ties broken on
 * `id`.
 *
 * The tie-break is load-bearing rather than cosmetic (0007, decision 2).
 * `position` defaults to `0` and carries no unique constraint, so without it two
 * rules created normally have no defined order — and "which rule wins" would
 * depend on the plan. Ids are UUIDv7, so a tie resolves in creation order, which
 * is also the answer a supervisor would guess.
 *
 * The same order the engine reads in, out of the same index. A list that showed
 * a different order from the one that routes would be worse than no list.
 */
const EVALUATION_ORDER = [
  { position: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.Enumerable<Prisma.AssignmentRuleOrderByWithRelationInput>;

/**
 * Routing rules (TAR-24), the supervisor-facing half.
 *
 * Rules are tenant *configuration*, not assignable records: everyone holding
 * `assignment_rule:read` sees all of them, and the visibility predicate that
 * scopes conversations and tickets to their assignee does not apply (0007,
 * security). Isolation is the tenant boundary alone, and it is `TenantPrisma`
 * and RLS that hold it.
 *
 * Two invariants live here rather than in the database, because the database
 * cannot express them and still let the shipped code work:
 *
 *   * **An active rule has exactly one target.** The CHECK constraint is
 *     conditional on `is_active` so that `UsersService` can leave a target-less
 *     inactive rule behind when a target user is removed; this refuses the
 *     enable that would violate it, and says which field is missing.
 *   * **A target belongs to this tenant.** The composite foreign keys
 *     `(tenant_id, id)` are what actually stop a cross-tenant target — RLS
 *     cannot, because the row carries our own `tenant_id` and satisfies the
 *     policy. Checking first turns a 500 from a constraint into a
 *     `validation_failed` naming the field.
 */
@Injectable()
export class AssignmentRulesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The whole set, in evaluation order.
   *
   * Unpaginated, which is 0002's one deviation for this resource and has a
   * reason (0007, REST surface): `rulesPerTenant` is enforced on create, the
   * engine loads the set whole per ticket anyway, and a cap the server enforces
   * *is* a promise it can keep. `nextCursor` stays in the shape and stays null,
   * so a generic list client works unchanged and pagination is addable without a
   * breaking change.
   */
  async list(): Promise<AssignmentRuleListResponse> {
    const rows = await this.prisma.assignmentRule.findMany({
      select: RULE_PROJECTION,
      orderBy: EVALUATION_ORDER,
      // One over the cap, so a set that somehow exceeded it is visible as a
      // fault rather than silently truncated to look complete.
      take: ROUTING_RULE_LIMITS.rulesPerTenant + 1,
    });

    return { items: rows.map(toAssignmentRuleResponse), nextCursor: null };
  }

  async get(ruleId: string): Promise<AssignmentRuleResponse> {
    const row = await this.prisma.assignmentRule.findUnique({
      where: { id: ruleId },
      select: RULE_PROJECTION,
    });

    if (row === null) {
      throw new AssignmentRuleNotFoundError(ruleId);
    }

    return toAssignmentRuleResponse(row);
  }

  async create(input: AssignmentRuleCreateInput): Promise<AssignmentRuleResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    return await this.prisma.$tenantTransaction(async (tx) => {
      await assertUnderRuleCap(tx);
      await assertReferencesExist(tx, tenantId, input.target, input.conditions);

      const row = await tx.assignmentRule
        .create({
          data: {
            tenantId,
            name: input.name,
            position: input.position ?? (await nextPosition(tx)),
            isActive: input.isActive,
            conditions: asJson(input.conditions),
            ...toTargetColumns(input.target),
          },
          select: RULE_PROJECTION,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? new AssignmentRuleNameTakenError(input.name) : error;
        });

      await this.recordChange(tx, AUDIT_ACTIONS.assignmentRuleCreated, row);

      return toAssignmentRuleResponse(row);
    });
  }

  /**
   * Partial update. A `position` here moves one rule and shifts the rules
   * between its old and new place by one; moving many at once is `reorder`.
   */
  async update(ruleId: string, input: AssignmentRuleUpdateInput): Promise<AssignmentRuleResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    return await this.prisma.$tenantTransaction(async (tx) => {
      const before = await tx.assignmentRule.findUnique({
        where: { id: ruleId },
        select: { id: true, name: true, position: true, isActive: true, ...targetColumns },
      });

      if (before === null) {
        throw new AssignmentRuleNotFoundError(ruleId);
      }

      // The target and the active flag are checked against the rule as it will
      // be *after* the patch, not as it was: enabling a rule and naming its
      // target in one call has to be allowed, and enabling one without naming a
      // target has to be refused.
      const target = input.target ?? toRoutingTarget(before);

      if ((input.isActive ?? before.isActive) && target === null) {
        throw new RuleNeedsTargetError(ruleId);
      }

      await assertReferencesExist(tx, tenantId, input.target ?? null, input.conditions ?? []);

      if (input.position !== undefined && input.position !== before.position) {
        await shiftBetween(tx, ruleId, before.position, input.position);
      }

      const row = await tx.assignmentRule
        .update({
          where: { id: ruleId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.position === undefined ? {} : { position: input.position }),
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
            ...(input.conditions === undefined ? {} : { conditions: asJson(input.conditions) }),
            ...(input.target === undefined ? {} : toTargetColumns(input.target)),
          },
          select: RULE_PROJECTION,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) && input.name !== undefined
            ? new AssignmentRuleNameTakenError(input.name)
            : error;
        });

      await this.recordChange(tx, AUDIT_ACTIONS.assignmentRuleUpdated, row);

      return toAssignmentRuleResponse(row);
    });
  }

  /**
   * `204`, and idempotent: deleting an already-deleted rule succeeds.
   *
   * Positions of the remaining rules are left alone. Gaps are harmless, because
   * the order is the sort and not the values — and closing them would rewrite
   * every row after the deleted one for no behaviour change.
   *
   * Nothing references a rule, so there is nothing to clear first. A ticket
   * routed by one keeps the rule's id and name in its `ticket_events` row, which
   * is a record of what happened and does not become wrong when the rule goes.
   */
  async delete(ruleId: string): Promise<void> {
    await this.prisma.$tenantTransaction(async (tx) => {
      const row = await tx.assignmentRule.findUnique({
        where: { id: ruleId },
        select: RULE_PROJECTION,
      });

      if (row === null) {
        return;
      }

      await tx.assignmentRule.delete({ where: { id: ruleId } });
      await this.recordChange(tx, AUDIT_ACTIONS.assignmentRuleDeleted, row);
    });
  }

  /**
   * Rewrites `position` to the array index, in one transaction.
   *
   * `ruleIds` is the tenant's **complete** set rather than a delta, on
   * `TeamUpdateInputSchema.memberUserIds`' reasoning — and here it also gives
   * optimistic concurrency for free: a submitted set that is not exactly the
   * current one means another supervisor added or deleted a rule since this
   * client loaded, and the answer is `conflict` rather than a silent partial
   * reorder.
   */
  async reorder(input: AssignmentRuleReorderInput): Promise<AssignmentRuleListResponse> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const held = await tx.assignmentRule.findMany({ select: { id: true } });

      if (
        !isSameSet(
          input.ruleIds,
          held.map((rule) => rule.id),
        )
      ) {
        throw new RuleSetChangedError();
      }

      // One statement per rule, bounded by `rulesPerTenant`. `updateMany` cannot
      // express "a different value per row" and the alternative — a raw
      // `UPDATE … FROM (VALUES …)` — would trade a readable statement for a
      // saving on a call a supervisor makes by hand.
      for (const [position, id] of input.ruleIds.entries()) {
        await tx.assignmentRule.updateMany({ where: { id }, data: { position } });
      }

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.assignmentRuleReordered,
        targetType: 'assignment_rule',
        // The operation is on the list, not on one rule. `targetId` is not
        // nullable, so it names the rule that now evaluates first — which is the
        // fact an auditor reading "somebody reordered routing" wants next.
        targetId: input.ruleIds[0] ?? EMPTY_RULE_SET_TARGET,
        metadata: { ruleIds: [...input.ruleIds] },
      });

      const rows = await tx.assignmentRule.findMany({
        select: RULE_PROJECTION,
        orderBy: EVALUATION_ORDER,
      });

      return { items: rows.map(toAssignmentRuleResponse), nextCursor: null };
    });
  }

  private async recordChange(
    tx: Prisma.TransactionClient,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    row: AssignmentRuleRow,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      targetType: 'assignment_rule',
      targetId: row.id,
      // The name and the target, never the conditions: a `contact_attribute`
      // value is tenant data and can carry PII, and the audit table is exported
      // for compliance review rather than being a place to discover it.
      metadata: { name: row.name, isActive: row.isActive, target: toRoutingTarget(row) },
    });
  }
}

/** Selected together often enough to be worth naming once. */
const targetColumns = { targetUserId: true, targetTeamId: true } as const;

/**
 * A reorder of an empty set is a no-op that still writes an audit row, and
 * `audit_logs.target_id` is not nullable. The all-zero UUID says "the list, not
 * a rule" without inventing a nullable column for a case that happens when a
 * console posts an empty array.
 */
const EMPTY_RULE_SET_TARGET = '00000000-0000-0000-0000-000000000000';

async function nextPosition(tx: Prisma.TransactionClient): Promise<number> {
  const { _max } = await tx.assignmentRule.aggregate({ _max: { position: true } });

  return _max.position === null ? 0 : _max.position + 1;
}

/**
 * The cap is checked, then the row is written, so two creates racing at the
 * boundary can both pass and leave the tenant one rule over. Accepted rather
 * than locked: the consequence is a 201st rule on a bound that exists to keep
 * per-ticket evaluation cheap, not a correctness failure, and an advisory lock
 * on every rule create would be a heavier mechanism than the risk deserves.
 */
async function assertUnderRuleCap(tx: Prisma.TransactionClient): Promise<void> {
  const held = await tx.assignmentRule.count();

  if (held >= ROUTING_RULE_LIMITS.rulesPerTenant) {
    throw new TooManyAssignmentRulesError();
  }
}

/**
 * Every id and key a rule points at, checked in tenant scope before the write.
 *
 * Four kinds, and all four answer `validation_failed` naming the field: a target
 * team, a target user, the `custom_field_defs.key` a `contact_attribute`
 * condition names, and the `tags.id`s a `tag` condition names. The last two
 * matter more than they look — a key or a tag id that resolves to nothing is a
 * typo, or a tag somebody has since deleted, and either way it is a condition
 * that can never be true again. A rule that never fires is the hardest kind of
 * routing bug to see, so it is refused on the way in rather than discovered by a
 * supervisor wondering where their tickets went.
 *
 * The console already refuses both, so this is also what keeps the API and the
 * mock it is developed against telling the same story.
 */
async function assertReferencesExist(
  tx: Prisma.TransactionClient,
  tenantId: string,
  target: RoutingTarget | null,
  conditions: readonly RoutingCondition[],
): Promise<void> {
  await assertTargetExists(tx, tenantId, target);
  await assertCustomFieldKeysExist(tx, tenantId, conditions);
  await assertTagIdsExist(tx, tenantId, conditions);
}

async function assertTargetExists(
  tx: Prisma.TransactionClient,
  tenantId: string,
  target: RoutingTarget | null,
): Promise<void> {
  if (target?.kind === 'team') {
    const team = await tx.team.findUnique({
      where: { tenantId_id: { tenantId, id: target.teamId } },
      select: { id: true },
    });

    if (team === null) {
      throw new UnknownRuleReferenceError('target.teamId', target.teamId);
    }
  }

  if (target?.kind === 'user') {
    const user = await tx.user.findUnique({
      where: { tenantId_id: { tenantId, id: target.userId } },
      select: { id: true },
    });

    if (user === null) {
      throw new UnknownRuleReferenceError('target.userId', target.userId);
    }
  }
}

async function assertCustomFieldKeysExist(
  tx: Prisma.TransactionClient,
  tenantId: string,
  conditions: readonly RoutingCondition[],
): Promise<void> {
  const keys = [
    ...new Set(
      conditions
        .filter((condition) => condition.type === 'contact_attribute')
        .map((condition) => condition.key),
    ),
  ];

  if (keys.length === 0) {
    return;
  }

  const defined = await tx.customFieldDef.findMany({
    where: { tenantId, key: { in: keys } },
    select: { key: true },
  });
  const known = new Set(defined.map((definition) => definition.key));
  const unknown = keys.find((key) => !known.has(key));

  if (unknown !== undefined) {
    throw new UnknownRuleReferenceError('conditions.key', unknown);
  }
}

/**
 * One query for every `tag` condition in the rule, out of `(tenant_id, id)`.
 *
 * The tenant predicate is the same one RLS applies, so a tag id belonging to
 * another tenant resolves to nothing and is refused exactly like an id that
 * never existed — which is the answer that confirms least.
 */
async function assertTagIdsExist(
  tx: Prisma.TransactionClient,
  tenantId: string,
  conditions: readonly RoutingCondition[],
): Promise<void> {
  const tagIds = [
    ...new Set(
      conditions
        .filter((condition) => condition.type === 'tag')
        .flatMap((condition) => condition.tagIds),
    ),
  ];

  if (tagIds.length === 0) {
    return;
  }

  const found = await tx.tag.findMany({
    where: { tenantId, id: { in: tagIds } },
    select: { id: true },
  });
  const known = new Set(found.map((tag) => tag.id));
  const unknown = tagIds.find((tagId) => !known.has(tagId));

  if (unknown !== undefined) {
    throw new UnknownRuleReferenceError('conditions.tagIds', unknown);
  }
}

/**
 * Moves one rule between two positions by shifting the rules it passes.
 *
 * Down the list, everything it steps over moves up one; up the list, everything
 * moves down one. `position` carries no unique constraint, so the intermediate
 * states this produces are legal and the shift needs no deferred constraint —
 * ties that survive it are resolved by the `id` tie-break, exactly as ties
 * created any other way are.
 */
async function shiftBetween(
  tx: Prisma.TransactionClient,
  ruleId: string,
  from: number,
  to: number,
): Promise<void> {
  const moved = { id: { not: ruleId } };

  if (to > from) {
    await tx.assignmentRule.updateMany({
      where: { ...moved, position: { gt: from, lte: to } },
      data: { position: { decrement: 1 } },
    });
    return;
  }

  await tx.assignmentRule.updateMany({
    where: { ...moved, position: { gte: to, lt: from } },
    data: { position: { increment: 1 } },
  });
}

/**
 * Same members, same count — so a `ruleIds` that repeats one id and omits
 * another is refused rather than reordering half the list. The schema does not
 * catch that on its own: it caps the array's length and does not assert
 * uniqueness.
 */
function isSameSet(submitted: readonly string[], held: readonly string[]): boolean {
  const unique = new Set(submitted);

  return (
    unique.size === submitted.length &&
    submitted.length === held.length &&
    held.every((id) => unique.has(id))
  );
}

/**
 * The conditions union is structurally a JSON value, but TypeScript will not
 * accept a `readonly` array or an interface where `Prisma.InputJsonValue`'s
 * index signature is expected. Serialised through JSON rather than asserted, so
 * what reaches the column is exactly what a reader will get back out of it.
 */
function asJson(conditions: readonly RoutingCondition[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(conditions)) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
