import { Inject, Injectable } from '@nestjs/common';
import {
  WORKFLOW_LIMITS,
  workflowReferenceUses,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowCreateInput,
  type WorkflowDefinition,
  type WorkflowListResponse,
  type WorkflowReferenceUse,
  type WorkflowReorderInput,
  type WorkflowResponse,
  type WorkflowTrigger,
  type WorkflowUpdateInput,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  readDefinition,
  referenceKey,
  toWorkflowResponse,
  WORKFLOW_PROJECTION,
  type ReferenceNames,
  type WorkflowRow,
} from './workflow.mapper';
import {
  TooManyElapsedTriggerWorkflowsError,
  TooManyWorkflowsError,
  UnknownWorkflowReferenceError,
  WorkflowNameTakenError,
  WorkflowNotFoundError,
  WorkflowReferenceBrokenError,
  WorkflowSetChangedError,
} from './workflows.errors';

/**
 * Execution order, everywhere it is read: ascending `position`, ties broken on
 * `id`.
 *
 * The tie-break is load-bearing rather than cosmetic, on 0007 decision 2's
 * reasoning: `position` defaults to `0` and carries no unique constraint, so
 * without it two workflows created normally have no defined order — and "which
 * one set the priority last" would depend on the plan. Ids are UUIDv7, so a tie
 * resolves in creation order, which is also the answer a supervisor would guess.
 *
 * The same order the evaluator reads in, out of the same index
 * (`workflows (tenant_id, is_active, trigger_type, position, id)`). A list that
 * showed a different order from the one that executes would be worse than no
 * list.
 */
const EXECUTION_ORDER = [
  { position: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.Enumerable<Prisma.WorkflowOrderByWithRelationInput>;

/**
 * Workflow automation (TAR-27), the supervisor-facing half — 0009's
 * `WorkflowService`, and the only writer of `workflows` and
 * `workflow_references`.
 *
 * Workflows are tenant *configuration*, not assignable records: everyone holding
 * `workflow:read` sees all of them, and the visibility predicate that scopes
 * conversations and tickets to their assignee does not apply. Isolation is the
 * tenant boundary alone, and it is `TenantPrisma` and RLS that hold it.
 *
 * ## Three invariants live here, and each has a database half
 *
 *   * **A broken workflow cannot be active.** `workflows_broken_is_inactive`
 *     makes it structural; this refuses the request that would violate it and
 *     names the reference that has to be replaced first, so a supervisor is told
 *     what to fix rather than shown a constraint violation.
 *   * **A reference belongs to this tenant.** The composite foreign keys
 *     `(tenant_id, id)` on `workflow_references` are what actually stop a
 *     cross-tenant reference — RLS cannot, because the row carries our own
 *     `tenant_id` and satisfies the policy. Checking first turns a 500 from a
 *     constraint into a `validation_failed` naming the field.
 *   * **`workflow_references` mirrors the definition exactly.** Rewritten inside
 *     the same transaction as every definition write, so the reverse index a
 *     taxonomy delete consults can never be stale — a tag whose last referencing
 *     workflow was just edited to drop it must be deletable in the next request.
 */
@Injectable()
export class WorkflowService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The whole set, in execution order.
   *
   * Unpaginated, which is 0002's one deviation for this resource and has 0007's
   * reason: `workflowsPerTenant` is enforced on create, the evaluator loads the
   * matching set whole per occurrence anyway, and a cap the server enforces *is*
   * a promise it can keep. `nextCursor` stays in the shape and stays null, so a
   * generic list client works unchanged and pagination is addable without a
   * breaking change.
   */
  async list(): Promise<WorkflowListResponse> {
    const rows = await this.prisma.workflow.findMany({
      select: WORKFLOW_PROJECTION,
      orderBy: EXECUTION_ORDER,
      // One over the cap, so a set that somehow exceeded it is visible as a
      // fault rather than silently truncated to look complete.
      take: WORKFLOW_LIMITS.workflowsPerTenant + 1,
    });

    return { items: await this.present(rows), nextCursor: null };
  }

  async get(workflowId: string): Promise<WorkflowResponse> {
    const row = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: WORKFLOW_PROJECTION,
    });

    if (row === null) {
      throw new WorkflowNotFoundError(workflowId);
    }

    const [response] = await this.present([row]);

    if (response === undefined) {
      throw new WorkflowNotFoundError(workflowId);
    }

    return response;
  }

  async create(input: WorkflowCreateInput): Promise<WorkflowResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const definition: WorkflowDefinition = {
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
    };

    const row = await this.prisma.$tenantTransaction(async (tx) => {
      await assertUnderWorkflowCap(tx);
      await assertUnderElapsedCap(tx, input.trigger, null);

      // Strict on create: every id was just chosen by the caller, so one that
      // resolves to nothing is input to fix rather than a reference to repair.
      const { uses } = await this.assertReferencesExist(tx, definition);

      const created = await tx.workflow
        .create({
          data: {
            tenantId,
            name: input.name,
            position: input.position ?? (await nextPosition(tx)),
            isActive: input.isActive,
            // Written in the same statement as `definition`, which is the whole
            // reason the duplication is safe (0009, data model).
            triggerType: input.trigger.type,
            definition: asJson(definition),
          },
          select: WORKFLOW_PROJECTION,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? new WorkflowNameTakenError(input.name) : error;
        });

      await writeReferences(tx, tenantId, created.id, uses);
      await this.recordChange(tx, AUDIT_ACTIONS.workflowCreated, created, definition);

      return created;
    });

    const [response] = await this.present([row]);

    return response ?? (await this.get(row.id));
  }

  /**
   * Partial update. A `position` here moves one workflow and shifts those
   * between its old and new place by one; moving many at once is `reorder`.
   *
   * ## `version` increments only when execution changed
   *
   * `trigger`, `conditions` or `actions` bump it; renaming, reordering or
   * toggling `isActive` do not, because nothing about *what the workflow does*
   * moved. The version is copied onto every run, so a supervisor reading a run
   * can tell whether the definition in front of them is the one that fired — and
   * a rename that bumped it would make that signal noisy for no gain.
   */
  async update(workflowId: string, input: WorkflowUpdateInput): Promise<WorkflowResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    const row = await this.prisma.$tenantTransaction(async (tx) => {
      const before = await tx.workflow.findUnique({
        where: { id: workflowId },
        select: WORKFLOW_PROJECTION,
      });

      if (before === null) {
        throw new WorkflowNotFoundError(workflowId);
      }

      const current = readDefinition(before);
      // Checked against the workflow as it will be *after* the patch, not as it
      // was: replacing a broken reference and enabling in one call has to be
      // allowed, and enabling without replacing it has to be refused.
      const definition: WorkflowDefinition = {
        trigger: input.trigger ?? current.trigger,
        conditions: input.conditions ?? current.conditions,
        actions: input.actions ?? current.actions,
      };
      const willBeActive = input.isActive ?? before.isActive;

      if (input.trigger !== undefined) {
        await assertUnderElapsedCap(tx, input.trigger, workflowId);
      }

      // Resolved, **not** refused. An unresolved reference on an update is the
      // thing being repaired, not bad input — see `assertReferencesExist`.
      const { uses, resolved } = await this.resolveDefinitionReferences(tx, definition);
      // The one question both rules below turn on (0009 decision 6 mechanism 3,
      // as amended on TAR-399).
      const everyReferenceResolves = uses.every((use) =>
        resolved.has(referenceKey(use.kind, use.id)),
      );

      // Arming is refused when, and only when, some reference does not resolve —
      // never because `brokenReason` happened to be set.
      //
      // The rejected rule read the document's "cannot be re-enabled **until**
      // every reference resolves" as a conjunction: fix it *in the request that
      // arms it*. That is a dead end in practice. The console's edit form carries
      // `isActive` through unchanged — correctly, arming is a deliberate act on
      // the list rather than a side effect of saving an edit — so the repair
      // PATCH is always `isActive: false`, and a workflow disarmed by an ordinary
      // user removal could never be enabled again by any request the UI produces.
      //
      // The safety that rule was reaching for is real and is already provided by
      // something else: `is_active` staying false. Clearing `brokenReason` arms
      // nothing. A repaired workflow sits disarmed until a human with
      // `workflow:write` sends `isActive: true`, and that request re-checks
      // every reference here. There is no path on which a rule nobody looked at
      // starts running by itself.
      if (willBeActive) {
        assertNothingBroken(uses, resolved);
      }

      const definitionChanged =
        input.trigger !== undefined ||
        input.conditions !== undefined ||
        input.actions !== undefined;

      if (input.position !== undefined && input.position !== before.position) {
        await shiftBetween(tx, workflowId, before.position, input.position);
      }

      const updated = await tx.workflow
        .update({
          where: { id: workflowId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.position === undefined ? {} : { position: input.position }),
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
            // **Derived state, not a latch.** Cleared whenever the post-patch
            // references all resolve, regardless of `isActive` — so the two-step
            // repair the console produces (correct the field with the workflow
            // still disarmed, then enable it from the list) leaves a healthy row
            // after step one rather than a permanently broken one.
            //
            // The invariant this establishes is what makes the field safe to
            // render and safe to ignore as a gate: `broken_reason IS NOT NULL`
            // implies at least one reference does not resolve.
            //
            // `workflows_broken_is_inactive` is unaffected — clearing while
            // inactive is always legal, and the constraint only forbids the
            // opposite pairing.
            ...(everyReferenceResolves ? { brokenReason: null } : {}),
            ...(definitionChanged
              ? {
                  triggerType: definition.trigger.type,
                  definition: asJson(definition),
                  version: { increment: 1 },
                }
              : {}),
          },
          select: WORKFLOW_PROJECTION,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) && input.name !== undefined
            ? new WorkflowNameTakenError(input.name)
            : error;
        });

      if (definitionChanged) {
        // Only the references that resolve. `workflow_references` is the reverse
        // index that makes a *delete* refusable, and a row that is already gone
        // needs no protection — but its composite foreign key would refuse the
        // insert outright, so an unresolved id must not reach it. The dangling id
        // stays in `definition`, which is exactly where 0009 decision 6 puts it:
        // the response reports `exists: false` and the console shows which field
        // needs a new value.
        await writeReferences(
          tx,
          tenantId,
          workflowId,
          uses.filter((use) => resolved.has(referenceKey(use.kind, use.id))),
        );
      }

      await this.recordChange(tx, AUDIT_ACTIONS.workflowUpdated, updated, definition);

      return updated;
    });

    const [response] = await this.present([row]);

    return response ?? (await this.get(row.id));
  }

  /**
   * `204`, and idempotent: deleting an already-deleted workflow succeeds.
   *
   * `workflow_runs` and `workflow_references` cascade, so the reverse index a
   * taxonomy delete consults empties with the workflow — a tag whose only
   * referencing workflow was just deleted is immediately deletable.
   *
   * Positions of the remaining workflows are left alone. Gaps are harmless,
   * because the order is the sort and not the values, and closing them would
   * rewrite every row after the deleted one for no behaviour change.
   */
  async delete(workflowId: string): Promise<void> {
    await this.prisma.$tenantTransaction(async (tx) => {
      const row = await tx.workflow.findUnique({
        where: { id: workflowId },
        select: WORKFLOW_PROJECTION,
      });

      if (row === null) {
        return;
      }

      await tx.workflow.delete({ where: { id: workflowId } });
      await this.recordChange(tx, AUDIT_ACTIONS.workflowDeleted, row, null);
    });
  }

  /**
   * Rewrites `position` to the array index, in one transaction.
   *
   * `workflowIds` is the tenant's **complete** set rather than a delta, which
   * gives optimistic concurrency for free: a submitted set that is not exactly
   * the current one means somebody else added or deleted a workflow since this
   * client loaded, and the answer is `conflict` rather than a silent partial
   * reorder. 0007's shape, unchanged.
   */
  async reorder(input: WorkflowReorderInput): Promise<WorkflowListResponse> {
    const rows = await this.prisma.$tenantTransaction(async (tx) => {
      const held = await tx.workflow.findMany({ select: { id: true } });

      if (
        !isSameSet(
          input.workflowIds,
          held.map((workflow) => workflow.id),
        )
      ) {
        throw new WorkflowSetChangedError();
      }

      // One statement per workflow, bounded by `workflowsPerTenant`.
      // `updateMany` cannot express "a different value per row", and the
      // alternative — a raw `UPDATE … FROM (VALUES …)` — would trade a readable
      // statement for a saving on a call a supervisor makes by hand.
      for (const [position, id] of input.workflowIds.entries()) {
        await tx.workflow.updateMany({ where: { id }, data: { position } });
      }

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.workflowReordered,
        targetType: 'workflow',
        // The operation is on the list, not on one workflow. `targetId` is not
        // nullable, so it names the workflow that now executes first.
        targetId: input.workflowIds[0] ?? EMPTY_WORKFLOW_SET_TARGET,
        metadata: { workflowIds: [...input.workflowIds] },
      });

      return await tx.workflow.findMany({ select: WORKFLOW_PROJECTION, orderBy: EXECUTION_ORDER });
    });

    return { items: await this.present(rows), nextCursor: null };
  }

  /**
   * Resolves every reference a set of workflows names, as one map.
   *
   * **Three queries for the whole page, never one per reference.** A 50-workflow
   * list naming a dozen tags each would otherwise be 600 round trips; this is
   * three `IN` reads against `tags`, `teams` and `users`, each served by the
   * primary key under RLS. Public because the dry run and the run list need the
   * same resolution.
   *
   * An id missing from the result is a reference whose row is gone. That is not
   * an error here — it is the `exists: false` the console renders.
   */
  async resolveReferences(rows: readonly WorkflowRow[]): Promise<ReferenceNames> {
    const uses = rows.flatMap((row) => {
      const definition = readDefinition(row);

      return workflowReferenceUses(definition.conditions, definition.actions);
    });

    return await this.namesFor(this.prisma, uses);
  }

  private async present(rows: readonly WorkflowRow[]): Promise<WorkflowResponse[]> {
    const names = await this.resolveReferences(rows);

    return rows.map((row) => toWorkflowResponse(row, names));
  }

  private async namesFor(
    client: ReferenceNameReader,
    uses: readonly WorkflowReferenceUse[],
  ): Promise<ReferenceNames> {
    const idsOf = (kind: WorkflowReferenceUse['kind']): string[] => [
      ...new Set(uses.filter((use) => use.kind === kind).map((use) => use.id)),
    ];

    const tagIds = idsOf('tag');
    const teamIds = idsOf('team');
    const userIds = idsOf('user');
    const names = new Map<string, string>();

    // Every read is under `TenantPrisma`, so an id belonging to another tenant
    // simply is not there and comes back as `exists: false` — the same answer a
    // deleted row gets, which is what 0004 requires.
    const [tags, teams, users] = await Promise.all([
      tagIds.length === 0
        ? []
        : client.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true, name: true } }),
      teamIds.length === 0
        ? []
        : client.team.findMany({
            where: { id: { in: teamIds } },
            select: { id: true, name: true },
          }),
      userIds.length === 0
        ? []
        : client.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          }),
    ]);

    for (const tag of tags) {
      names.set(referenceKey('tag', tag.id), tag.name);
    }

    for (const team of teams) {
      names.set(referenceKey('team', team.id), team.name);
    }

    for (const user of users) {
      names.set(referenceKey('user', user.id), user.name);
    }

    return names;
  }

  /**
   * Every id the definition names, checked in tenant scope before the write, and
   * returned so the caller writes the reverse index from the same list.
   *
   * A reference that resolves to nothing is not a leak — every read here is
   * tenant-scoped. It is worse than that in the way that is hard to see: the
   * workflow saves, reports success, and then silently never does what it says
   * again. That is the shape a supervisor cannot debug, so it is refused at the
   * boundary — 0007's argument for `assertTagIdsExist`, applied to a surface
   * that also writes.
   */
  private async resolveDefinitionReferences(
    tx: Prisma.TransactionClient,
    definition: WorkflowDefinition,
  ): Promise<ResolvedReferences> {
    const uses = workflowReferenceUses(definition.conditions, definition.actions);
    const names = await this.namesFor(tx, uses);

    return { uses, resolved: new Set(names.keys()) };
  }

  /**
   * Every id the definition names, refused if any is not in this tenant.
   *
   * **Create only**, and the asymmetry with `update` is the point. On a create
   * every id is one the caller just picked, so an id that resolves to nothing is
   * a typo or another tenant's row — `validation_failed` naming the field is the
   * answer, and there is no "it was valid and the row went away" case to
   * confuse it with.
   *
   * On an update there is, and refusing there would make the repair impossible:
   * a workflow disarmed by an ordinary user removal could not be saved at all,
   * because the dead id is still in the definition being edited. So `update`
   * resolves without refusing and gates *arming* instead (0009 decision 6
   * mechanism 3, as amended on TAR-399).
   */
  private async assertReferencesExist(
    tx: Prisma.TransactionClient,
    definition: WorkflowDefinition,
  ): Promise<ResolvedReferences> {
    const resolution = await this.resolveDefinitionReferences(tx, definition);
    const unknown = resolution.uses.find(
      (use) => !resolution.resolved.has(referenceKey(use.kind, use.id)),
    );

    if (unknown !== undefined) {
      throw new UnknownWorkflowReferenceError(unknown.path, unknown.id);
    }

    return resolution;
  }

  private async recordChange(
    tx: Prisma.TransactionClient,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    row: WorkflowRow,
    definition: WorkflowDefinition | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      targetType: 'workflow',
      targetId: row.id,
      // The name, the trigger type and the action types — **never the
      // conditions**, on the rule `assignment_rule.*` already follows: a
      // condition can carry tenant data, and this table is exported for
      // compliance review rather than being a place to discover it.
      metadata: {
        name: row.name,
        isActive: row.isActive,
        triggerType: row.triggerType,
        actionTypes: (definition?.actions ?? []).map((action) => action.type),
      },
    });
  }
}

/**
 * A definition's taxonomy references, and which of them a live read found.
 *
 * The pair travels together because every rule in this file is about the
 * *difference* between them: arming is refused when it is non-empty,
 * `broken_reason` is cleared when it is empty, and `workflow_references` indexes
 * only the resolved half.
 */
interface ResolvedReferences {
  readonly uses: readonly WorkflowReferenceUse[];
  /** `referenceKey` values a live, tenant-scoped read returned a name for. */
  readonly resolved: ReadonlySet<string>;
}

/**
 * The three delegates the reference resolver reads, as a structural port.
 *
 * `TenantPrisma` and `Prisma.TransactionClient` are two different Prisma client
 * types — the first carries the `$tenantTransaction` extension — and neither is
 * assignable to the other, so a parameter typed as one of them cannot take the
 * other. The resolver runs on both: on the client for a read, and on the
 * caller's transaction for a write, where it has to see rows the same
 * transaction just wrote.
 *
 * Narrowing to what is actually called is the honest fix rather than a cast: it
 * says the resolver reads three tables by id and nothing else, and it fails to
 * compile if either client ever stops offering that.
 */
interface ReferenceNameReader {
  tag: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; name: true };
    }): Promise<{ id: string; name: string }[]>;
  };
  team: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; name: true };
    }): Promise<{ id: string; name: string }[]>;
  };
  user: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; name: true };
    }): Promise<{ id: string; name: string }[]>;
  };
}

/**
 * A reorder of an empty set is a no-op that still writes an audit row, and
 * `audit_logs.target_id` is not nullable. The all-zero UUID says "the list, not
 * a workflow" without inventing a nullable column — `assignment-rules.service`'s
 * answer to the same shape.
 */
const EMPTY_WORKFLOW_SET_TARGET = '00000000-0000-0000-0000-000000000000';

/**
 * Rewrites the reverse index for one workflow: delete every row, insert one per
 * distinct entity, inside the caller's transaction.
 *
 * Delete-then-insert rather than a diff. The set is at most
 * `conditionsPerWorkflow × valuesPerCondition + actionsPerWorkflow` rows, the
 * whole thing runs inside a transaction a supervisor is waiting on, and a diff
 * would be more code to get wrong for a saving nobody can measure.
 *
 * `createMany` with `skipDuplicates` is the second half of the same guarantee:
 * `workflow_references_scope_key` is `NULLS NOT DISTINCT` in the database, so a
 * workflow naming the same tag from a condition and an action would otherwise
 * raise `23505` on the second row rather than storing one.
 */
async function writeReferences(
  tx: Prisma.TransactionClient,
  tenantId: string,
  workflowId: string,
  uses: readonly WorkflowReferenceUse[],
): Promise<void> {
  await tx.workflowReference.deleteMany({ where: { workflowId } });

  if (uses.length === 0) {
    return;
  }

  const seen = new Set<string>();
  const rows = uses.flatMap((use) => {
    const key = referenceKey(use.kind, use.id);

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);

    return [
      {
        tenantId,
        workflowId,
        tagId: use.kind === 'tag' ? use.id : null,
        teamId: use.kind === 'team' ? use.id : null,
        userId: use.kind === 'user' ? use.id : null,
      },
    ];
  });

  await tx.workflowReference.createMany({ data: rows, skipDuplicates: true });
}

async function nextPosition(tx: Prisma.TransactionClient): Promise<number> {
  const { _max } = await tx.workflow.aggregate({ _max: { position: true } });

  return _max.position === null ? 0 : _max.position + 1;
}

/**
 * The cap is checked, then the row is written, so two creates racing at the
 * boundary can both pass and leave the tenant one workflow over. Accepted rather
 * than locked, on `assignment-rules.service.ts`' reasoning: the consequence is a
 * 51st workflow on a bound that exists to keep per-occurrence evaluation cheap,
 * not a correctness failure.
 */
async function assertUnderWorkflowCap(tx: Prisma.TransactionClient): Promise<void> {
  if ((await tx.workflow.count()) >= WORKFLOW_LIMITS.workflowsPerTenant) {
    throw new TooManyWorkflowsError();
  }
}

/**
 * The separate, lower cap on elapsed triggers — checked only when the write
 * would produce one, and excluding the workflow being edited so that changing a
 * threshold on an existing elapsed workflow is never refused for being one.
 */
async function assertUnderElapsedCap(
  tx: Prisma.TransactionClient,
  trigger: WorkflowTrigger,
  excludeWorkflowId: string | null,
): Promise<void> {
  if (trigger.type !== 'ticket_unresolved_for') {
    return;
  }

  const held = await tx.workflow.count({
    where: {
      triggerType: 'ticket_unresolved_for',
      ...(excludeWorkflowId === null ? {} : { id: { not: excludeWorkflowId } }),
    },
  });

  if (held >= WORKFLOW_LIMITS.elapsedTriggerWorkflowsPerTenant) {
    throw new TooManyElapsedTriggerWorkflowsError();
  }
}

/**
 * Refuses to arm a workflow whose references do not all resolve, naming each
 * broken one by its path in the definition.
 *
 * `workflow_reference_broken`, not `validation_failed`: the body is well-formed
 * and the caller changed nothing — a colleague deleted a tag last week — so the
 * console's next action is "pick a replacement", not "fix your input".
 */
function assertNothingBroken(
  uses: readonly WorkflowReferenceUse[],
  resolved: ReadonlySet<string>,
): void {
  const broken = uses.filter((use) => !resolved.has(referenceKey(use.kind, use.id)));

  if (broken.length > 0) {
    throw new WorkflowReferenceBrokenError(broken);
  }
}

/**
 * Moves one workflow between two positions by shifting the ones it passes.
 *
 * `position` carries no unique constraint, so the intermediate states this
 * produces are legal and the shift needs no deferred constraint — ties that
 * survive it are resolved by the `id` tie-break, exactly as ties created any
 * other way are.
 */
async function shiftBetween(
  tx: Prisma.TransactionClient,
  workflowId: string,
  from: number,
  to: number,
): Promise<void> {
  const moved = { id: { not: workflowId } };

  if (to > from) {
    await tx.workflow.updateMany({
      where: { ...moved, position: { gt: from, lte: to } },
      data: { position: { decrement: 1 } },
    });
    return;
  }

  await tx.workflow.updateMany({
    where: { ...moved, position: { gte: to, lt: from } },
    data: { position: { increment: 1 } },
  });
}

/**
 * Same members, same count — so a `workflowIds` that repeats one id and omits
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
 * The definition is structurally a JSON value, but TypeScript will not accept a
 * `readonly` array or an interface where `Prisma.InputJsonValue`'s index
 * signature is expected. Serialised through JSON rather than asserted, so what
 * reaches the column is exactly what a reader will get back out of it —
 * `assignment-rules.service.ts`' `asJson`, for the same reason.
 */
function asJson(definition: {
  trigger: WorkflowTrigger;
  conditions: readonly WorkflowCondition[];
  actions: readonly WorkflowAction[];
}): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(definition)) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
