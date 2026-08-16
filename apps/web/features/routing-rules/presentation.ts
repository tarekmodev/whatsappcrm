import {
  CONTACT_ATTRIBUTE_OPERATORS,
  ROUTING_CONDITION_TYPES,
  contactAttributeOperatorTakesValue,
  type ContactAttributeCondition,
  type ContactAttributeOperator,
  type CustomFieldDefinition,
  type RoutingCondition,
  type RoutingConditionType,
  type RoutingTarget,
  type Tag,
  type TeamResponse,
  type UserResponse,
} from '@whatsappcrm/contracts';
import type { SelectOption } from '@/components/ui/Select';
import type { Content } from '@/lib/content';
import { LIST_MOVE_DIRECTIONS, movedIds, type ListMoveDirection } from '@/lib/list-order';

/**
 * Turns a rule's grammar into the sentence a supervisor reads, and back into the
 * option lists the form offers.
 *
 * Pure and free of React on purpose: "does `bill` mean any or all" and "what does
 * this rule actually do" are the two things about this surface most worth testing,
 * and neither needs a DOM.
 */

/** Everything a condition or target can point at, resolved once per render. */
export interface RoutingRuleVocabulary {
  readonly teams: readonly TeamResponse[];
  readonly users: readonly UserResponse[];
  readonly tags: readonly Tag[];
  readonly customFields: readonly CustomFieldDefinition[];
}

export const EMPTY_VOCABULARY: RoutingRuleVocabulary = {
  teams: [],
  users: [],
  tags: [],
  customFields: [],
};

/**
 * A condition as one clause of "matches when …".
 *
 * A tag or field the rule names may have been deleted since it was written. That
 * shows as "a deleted item" rather than as a raw UUID or a silently dropped
 * clause: the rule really does still reference it, and the supervisor is the one
 * who has to decide what to do about that.
 */
export function describeCondition(
  condition: RoutingCondition,
  vocabulary: RoutingRuleVocabulary,
  content: Content,
): string {
  const copy = content.routingRules;

  switch (condition.type) {
    case 'keyword': {
      const values = formatList(condition.values, condition.match, content);

      return condition.match === 'any'
        ? copy.summaryKeywordAny(values)
        : copy.summaryKeywordAll(values);
    }

    case 'tag': {
      const names = condition.tagIds.map(
        (tagId) =>
          vocabulary.tags.find((tag) => tag.id === tagId)?.name ?? copy.summaryUnknownReference,
      );
      const tags = formatList(names, condition.match, content);

      return condition.match === 'any' ? copy.summaryTagAny(tags) : copy.summaryTagAll(tags);
    }

    case 'business_hours':
      return condition.within ? copy.summaryBusinessHoursWithin : copy.summaryBusinessHoursOutside;

    case 'contact_attribute': {
      const field =
        vocabulary.customFields.find((definition) => definition.key === condition.key)?.label ??
        copy.summaryUnknownReference;
      const operator = operatorLabel(condition.operator, content);
      const comparison =
        condition.value === null ? operator : copy.summaryAttributeValue(operator, condition.value);

      return copy.summaryAttribute(field, comparison);
    }
  }
}

/** Where a matching conversation goes, or why the rule cannot be turned on. */
export function describeTarget(
  target: RoutingTarget | null,
  vocabulary: RoutingRuleVocabulary,
  content: Content,
): string {
  const copy = content.routingRules;

  if (target === null) {
    return copy.targetMissing;
  }

  if (target.kind === 'team') {
    const team = vocabulary.teams.find((candidate) => candidate.id === target.teamId);

    return copy.routeToTeam(team?.name ?? copy.unknownTeam);
  }

  const user = vocabulary.users.find((candidate) => candidate.id === target.userId);

  return copy.routeToUser(user?.displayName ?? copy.unknownUser);
}

export const RULE_MOVE_DIRECTIONS = LIST_MOVE_DIRECTIONS;
export type RuleMoveDirection = ListMoveDirection;

/**
 * The rule set with one rule swapped past its neighbour, or `null` when it is
 * already at that end — which is what the list disables the control on, rather
 * than sending a reorder that would change nothing.
 *
 * The whole set comes back because that is what the reorder endpoint takes: a
 * delta would lose to a concurrent edit, and the whole set is also this call's
 * optimistic concurrency.
 *
 * The move itself is `lib/list-order.ts`, shared with the workflow list, which
 * reorders on exactly the same terms (ADR 0009 decision 4).
 */
export function movedRuleIds(
  ruleIds: readonly string[],
  ruleId: string,
  direction: RuleMoveDirection,
): readonly string[] | null {
  return movedIds(ruleIds, ruleId, direction);
}

/**
 * A newly added condition of the chosen type, valid enough to render but not yet
 * to submit — the form's own validation is what stops an empty one being sent.
 */
export function blankCondition(
  type: RoutingConditionType,
  vocabulary: RoutingRuleVocabulary,
): RoutingCondition {
  switch (type) {
    case 'keyword':
      return { type: 'keyword', match: 'any', values: [] };

    case 'tag':
      return { type: 'tag', match: 'any', tagIds: [] };

    case 'business_hours':
      return { type: 'business_hours', within: false };

    case 'contact_attribute':
      return {
        type: 'contact_attribute',
        key: vocabulary.customFields[0]?.key ?? '',
        operator: 'equals',
        value: '',
      };
  }
}

/**
 * The condition types the form offers.
 *
 * `tag` and `contact_attribute` are dropped when the workspace has nothing for
 * them to match on: a tag condition with no tags to choose from can only ever be
 * an invalid rule, and offering it would send the supervisor to a refusal.
 */
export function availableConditionTypes(
  vocabulary: RoutingRuleVocabulary,
): readonly RoutingConditionType[] {
  return ROUTING_CONDITION_TYPES.filter((type) => {
    if (type === 'tag') {
      return vocabulary.tags.length > 0;
    }

    if (type === 'contact_attribute') {
      return vocabulary.customFields.length > 0;
    }

    return true;
  });
}

export function conditionTypeOptions(
  types: readonly RoutingConditionType[],
  content: Content,
): readonly SelectOption[] {
  return types.map((type) => ({ value: type, label: conditionTypeLabel(type, content) }));
}

export function conditionTypeLabel(type: RoutingConditionType, content: Content): string {
  const copy = content.routingRules;

  return {
    keyword: copy.conditionTypeKeyword,
    tag: copy.conditionTypeTag,
    business_hours: copy.conditionTypeBusinessHours,
    contact_attribute: copy.conditionTypeContactAttribute,
  }[type];
}

export function operatorOptions(content: Content): readonly SelectOption[] {
  return CONTACT_ATTRIBUTE_OPERATORS.map((operator) => ({
    value: operator,
    label: operatorLabel(operator, content),
  }));
}

export function operatorLabel(operator: ContactAttributeOperator, content: Content): string {
  const copy = content.routingRules;

  return {
    equals: copy.operatorEquals,
    not_equals: copy.operatorNotEquals,
    contains: copy.operatorContains,
    is_set: copy.operatorIsSet,
    is_not_set: copy.operatorIsNotSet,
  }[operator];
}

/**
 * Normalises a `contact_attribute` condition after its operator changed, so
 * `value` is null exactly when the operator compares against nothing — the
 * invariant the contract refines on, kept here so no caller has to remember it.
 */
export function withOperator(
  condition: ContactAttributeCondition,
  operator: ContactAttributeOperator,
): ContactAttributeCondition {
  return {
    ...condition,
    operator,
    value: contactAttributeOperatorTakesValue(operator) ? (condition.value ?? '') : null,
  };
}

/**
 * `Intl.ListFormat` rather than joining on a comma: "a, b and c" versus
 * "a, b or c" is the difference between `all` and `any`, and it is the phrasing
 * the browser already knows how to get right. The locale comes from the content
 * module, so server and client format identically.
 */
function formatList(values: readonly string[], match: 'any' | 'all', content: Content): string {
  return new Intl.ListFormat(content.locale, {
    style: 'long',
    type: match === 'any' ? 'disjunction' : 'conjunction',
  }).format(values);
}
