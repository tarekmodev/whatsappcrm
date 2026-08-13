'use server';

import {
  AssignmentRuleCreateInputSchema,
  AssignmentRuleReorderInputSchema,
  AssignmentRuleUpdateInputSchema,
} from '@whatsappcrm/contracts';
import {
  createAssignmentRule,
  deleteAssignmentRule,
  reorderAssignmentRules,
  updateAssignmentRule,
} from '@/lib/api/assignment-rules';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * Mutations for the routing-rule surface. Each asserts `assignment_rule:write`
 * — the permission 0007 assigns these endpoints — validates against the
 * contract's own schema, and comes back as a value rather than a throw;
 * `runAction` owns that sequence.
 *
 * There is nothing here beyond it, on purpose. Every rule about a routing rule —
 * one target not two, a value only where the operator takes one, no enabling a
 * rule without a target, a reorder that is the whole set — is expressed in the
 * contract or enforced by the API, so this module has no invariant of its own to
 * restate and get subtly wrong.
 */

/** The surface these mutations re-render. `settingsAssignment()` takes no query. */
const ASSIGNMENT_PATH = routes.settingsAssignment();

const ACTION_LABEL = 'Routing rules';

export async function createRoutingRuleAction(
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  return runAction({
    permission: 'assignment_rule:write',
    parser: AssignmentRuleCreateInputSchema,
    input,
    revalidate: ASSIGNMENT_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const rule = await createAssignmentRule(parsed);

      return { name: rule.name };
    },
  });
}

export async function updateRoutingRuleAction(
  ruleId: string,
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  return runAction({
    permission: 'assignment_rule:write',
    parser: AssignmentRuleUpdateInputSchema,
    input,
    revalidate: ASSIGNMENT_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const rule = await updateAssignmentRule(ruleId, parsed);

      return { name: rule.name };
    },
  });
}

/**
 * The enable/disable switch. A `PATCH` like any other, so a rule with no target
 * is refused by the API with copy naming what is missing — the console disables
 * the control as well, but the refusal is what makes it safe.
 */
export async function setRoutingRuleActiveAction(
  ruleId: string,
  isActive: boolean,
): Promise<ActionResult<{ name: string; isActive: boolean }>> {
  return runAction({
    permission: 'assignment_rule:write',
    parser: AssignmentRuleUpdateInputSchema,
    input: { isActive },
    revalidate: ASSIGNMENT_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const rule = await updateAssignmentRule(ruleId, parsed);

      return { name: rule.name, isActive: rule.isActive };
    },
  });
}

export async function deleteRoutingRuleAction(
  ruleId: string,
  name: string,
): Promise<ActionResult<{ name: string }>> {
  return runAction({
    permission: 'assignment_rule:write',
    parser: null,
    input: undefined,
    revalidate: ASSIGNMENT_PATH,
    label: ACTION_LABEL,
    perform: async () => {
      await deleteAssignmentRule(ruleId);

      return { name };
    },
  });
}

export async function reorderRoutingRulesAction(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return runAction({
    permission: 'assignment_rule:write',
    parser: AssignmentRuleReorderInputSchema,
    input,
    revalidate: ASSIGNMENT_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const rules = await reorderAssignmentRules(parsed);

      return { count: rules.length };
    },
  });
}
