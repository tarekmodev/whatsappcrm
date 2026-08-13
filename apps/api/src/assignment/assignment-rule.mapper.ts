import {
  RoutingConditionListSchema,
  type AssignmentRuleResponse,
  type RoutingCondition,
  type RoutingTarget,
} from '@whatsappcrm/contracts';
import { MalformedRuleConditionsError } from './assignment.errors';

/**
 * Row → response. Explicit field by field, never a spread — the boundary that
 * stops a column reaching the API by accident (`people.mapper.ts`).
 *
 * Two mappings happen here and nowhere else, and both are the seam between what
 * the database can express and what the contract publishes:
 *
 *   * **`conditions` is JSONB in, a validated union out.** The column is
 *     deliberately schemaless so the grammar can evolve without a migration, so
 *     something has to hold the grammar — this does.
 *   * **The target is two nullable foreign keys in, a discriminated union out.**
 *     The columns are what give the target a real foreign key; the union is what
 *     makes "exactly one" unrepresentable-if-wrong for the console.
 */

/** Exactly the columns an `AssignmentRuleResponse` needs, and no others. */
export interface AssignmentRuleRow {
  id: string;
  name: string;
  position: number;
  isActive: boolean;
  conditions: unknown;
  targetUserId: string | null;
  targetTeamId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toAssignmentRuleResponse(row: AssignmentRuleRow): AssignmentRuleResponse {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    isActive: row.isActive,
    conditions: parseConditions(row.id, row.conditions),
    target: toRoutingTarget(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Both columns null is a real state, not a defect: `UsersService` clears
 * `targetUserId` and deactivates the rule when its target user is removed, so a
 * supervisor finds a rule needing a new target rather than finding it gone.
 *
 * Both columns *set* is not reachable — the CHECK refuses it on an active rule
 * and nothing writes both — and if it ever were, the user wins here rather than
 * the mapper throwing, because a routing surface that will not render is worse
 * than one that renders a stale half.
 */
export function toRoutingTarget(row: {
  targetUserId: string | null;
  targetTeamId: string | null;
}): RoutingTarget | null {
  if (row.targetUserId !== null) {
    return { kind: 'user', userId: row.targetUserId };
  }

  return row.targetTeamId === null ? null : { kind: 'team', teamId: row.targetTeamId };
}

/** The write half of the same mapping: a union in, the two columns out. */
export function toTargetColumns(target: RoutingTarget | null): {
  targetUserId: string | null;
  targetTeamId: string | null;
} {
  if (target === null) {
    return { targetUserId: null, targetTeamId: null };
  }

  return target.kind === 'user'
    ? { targetUserId: target.userId, targetTeamId: null }
    : { targetUserId: null, targetTeamId: target.teamId };
}

/**
 * Validates stored JSONB against the published grammar.
 *
 * Throws on failure, which the API surfaces as a fault rather than hiding.
 * Unreachable in practice — the API is the only writer and validates on the way
 * in — but a rule whose conditions nobody can read is configuration the
 * supervisor has to be told about. The engine makes the opposite call on the
 * same data and skips the rule, because its job is to not misroute a live
 * ticket; see `RuleEngineService`.
 */
export function parseConditions(ruleId: string, stored: unknown): RoutingCondition[] {
  const parsed = RoutingConditionListSchema.safeParse(stored);

  if (!parsed.success) {
    throw new MalformedRuleConditionsError(ruleId, parsed.error.message);
  }

  return parsed.data;
}
