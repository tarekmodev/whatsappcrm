import {
  AssignmentRuleCreateInputSchema,
  ROUTING_RULE_FIELD_LENGTHS,
  ROUTING_RULE_LIMITS,
  contactAttributeOperatorTakesValue,
  type AssignmentRuleCreateInput,
  type AssignmentRuleResponse,
  type RoutingCondition,
  type RoutingTarget,
} from '@whatsappcrm/contracts';
import type { Content } from '@/lib/content';

/**
 * The rule form's state, and the one function that decides whether it can be
 * submitted.
 *
 * Validation runs against the contract's own schema as the last step, so the user
 * is not sent on a round trip to learn that a field is empty — but the per-field
 * messages come first, because a schema failure says "conditions[1].values" and a
 * supervisor needs "add at least one word or phrase", next to the field it is
 * about.
 *
 * Pure, so the rules that are easy to get wrong — a keyword list that is only
 * blank lines, an operator that must not carry a value, an edit that must not
 * silently switch a rule back on — are unit-testable without a DOM.
 */

export interface RuleDraft {
  readonly name: string;
  readonly conditions: readonly RoutingCondition[];
  readonly target: RoutingTarget | null;
  /**
   * Carried, never edited here. The list owns the on/off switch; a form that
   * defaulted this would turn a disabled rule back on the moment someone fixed a
   * typo in its name.
   */
  readonly isActive: boolean;
}

export interface RuleDraftErrors {
  readonly name?: string;
  readonly conditions?: string;
  readonly target?: string;
  /** Keyed by the condition's index in the draft. */
  readonly byCondition: Readonly<Record<number, string>>;
  /** A failure no field owns; shown above the actions. */
  readonly form?: string;
}

export type RuleDraftValidation =
  | { readonly status: 'valid'; readonly input: AssignmentRuleCreateInput }
  | { readonly status: 'invalid'; readonly errors: RuleDraftErrors };

/** A blank rule, and the shape an existing one is edited from. */
export function draftFromRule(rule: AssignmentRuleResponse | null): RuleDraft {
  if (rule === null) {
    return { name: '', conditions: [], target: null, isActive: true };
  }

  return {
    name: rule.name,
    conditions: [...rule.conditions],
    target: rule.target,
    isActive: rule.isActive,
  };
}

export function validateRuleDraft(draft: RuleDraft, content: Content): RuleDraftValidation {
  const copy = content.routingRules;
  const byCondition: Record<number, string> = {};
  let name: string | undefined;
  let conditions: string | undefined;
  let target: string | undefined;

  const trimmedName = draft.name.trim();

  if (trimmedName.length === 0) {
    name = copy.nameRequiredError;
  } else if (trimmedName.length > ROUTING_RULE_FIELD_LENGTHS.name) {
    name = copy.nameTooLongError(ROUTING_RULE_FIELD_LENGTHS.name);
  }

  if (draft.conditions.length === 0) {
    conditions = copy.conditionsRequiredError;
  }

  const cleanedConditions = draft.conditions.map((condition, index) => {
    const cleaned = cleanCondition(condition);
    const message = conditionError(cleaned, content);

    if (message !== null) {
      byCondition[index] = message;
    }

    return cleaned;
  });

  if (draft.target === null) {
    target = copy.targetRequiredError;
  }

  const hasFieldError =
    name !== undefined ||
    conditions !== undefined ||
    target !== undefined ||
    Object.keys(byCondition).length > 0;

  if (hasFieldError) {
    return { status: 'invalid', errors: { name, conditions, target, byCondition } };
  }

  const parsed = AssignmentRuleCreateInputSchema.safeParse({
    name: trimmedName,
    conditions: cleanedConditions,
    target: draft.target,
    isActive: draft.isActive,
  });

  if (!parsed.success) {
    // Everything above passed, so this is a grammar the form let through — a bug
    // rather than a user mistake. Say so generically instead of showing a Zod path.
    return {
      status: 'invalid',
      errors: { byCondition: {}, form: content.form.genericSubmitError },
    };
  }

  return { status: 'valid', input: parsed.data };
}

/**
 * Drops what the controls leave behind: the blank line at the end of a textarea,
 * the surrounding spaces on a pasted keyword, and the value an operator that
 * compares against nothing must not carry.
 */
function cleanCondition(condition: RoutingCondition): RoutingCondition {
  switch (condition.type) {
    case 'keyword':
      return {
        ...condition,
        values: condition.values.map((value) => value.trim()).filter((value) => value.length > 0),
      };

    case 'contact_attribute':
      return {
        ...condition,
        value: contactAttributeOperatorTakesValue(condition.operator)
          ? (condition.value?.trim() ?? '')
          : null,
      };

    default:
      return condition;
  }
}

function conditionError(condition: RoutingCondition, content: Content): string | null {
  const copy = content.routingRules;

  switch (condition.type) {
    case 'keyword': {
      if (condition.values.length === 0) {
        return copy.keywordValuesRequiredError;
      }

      if (condition.values.length > ROUTING_RULE_LIMITS.valuesPerCondition) {
        return copy.keywordValuesTooManyError(ROUTING_RULE_LIMITS.valuesPerCondition);
      }

      const tooLong = condition.values.some(
        (value) => value.length > ROUTING_RULE_LIMITS.keywordLength,
      );

      return tooLong ? copy.keywordTooLongError(ROUTING_RULE_LIMITS.keywordLength) : null;
    }

    case 'tag': {
      if (condition.tagIds.length === 0) {
        return copy.tagsRequiredError;
      }

      // `TagConditionSchema` caps this the same way it caps keyword values, and
      // the checkbox group does not, so a workspace with more than 25 tags can
      // reach the cap by clicking.
      return condition.tagIds.length > ROUTING_RULE_LIMITS.valuesPerCondition
        ? copy.tagsTooManyError(ROUTING_RULE_LIMITS.valuesPerCondition)
        : null;
    }

    case 'business_hours':
      return null;

    case 'contact_attribute':
      return condition.value !== null && condition.value.length === 0
        ? copy.attributeValueRequiredError
        : null;
  }
}
