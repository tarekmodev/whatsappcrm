import type {
  ContactAttributeCondition,
  KeywordCondition,
  RoutingCondition,
  RoutingConditionMatch,
  TagCondition,
} from '@whatsappcrm/contracts';
import type { RoutingFacts } from './routing-facts';

/**
 * The condition grammar, evaluated.
 *
 * Pure functions over `RoutingFacts` — no database, no tenant context, no
 * framework. That is what makes the table of cases in `rule-conditions.spec.ts`
 * a readable specification rather than a fixture exercise, and it is why the
 * engine resolves its facts first and compares second.
 *
 * Two properties hold for every branch below, and both come from 0007:
 *
 *   * **Conditions inside a rule combine with AND**, and rules combine with OR
 *     by being an ordered list. There is no rule-level `any`/`all` toggle and no
 *     nested tree.
 *   * **A condition with no data to read is false.** It never throws, and it
 *     never matches — including a `business_hours` condition asking `within:
 *     false` of a tenant that never configured hours.
 */

/** Every condition holds. An empty list cannot occur — the API refuses one. */
export function ruleMatches(conditions: readonly RoutingCondition[], facts: RoutingFacts): boolean {
  return conditions.every((condition) => conditionMatches(condition, facts));
}

export function conditionMatches(condition: RoutingCondition, facts: RoutingFacts): boolean {
  switch (condition.type) {
    case 'keyword':
      return keywordMatches(condition, facts.messageBody);
    case 'tag':
      return tagMatches(condition, facts.tagIds);
    case 'business_hours':
      // `withinBusinessHours === null` is "unanswerable", and it is false for
      // both settings of `within` rather than being the opposite of `true`.
      return facts.withinBusinessHours !== null && facts.withinBusinessHours === condition.within;
    case 'contact_attribute':
      return contactAttributeMatches(condition, facts.customFields);
  }
}

/**
 * Substring, case-insensitive, on the trimmed value — what "contains" means to
 * the person writing the rule. Not word-boundary aware, so `bill` matches
 * `billing` and also `billboard`; 0007 accepts that at v1 (risk 4) because the
 * alternative is tenant-authored regular expressions, which is a
 * denial-of-service surface pointed at our own worker.
 *
 * A value that is nothing but whitespace never matches. It survives the
 * schema's `min(1)` and `''.includes('')` is true, so without this one blank
 * box in the console would turn a rule into "match everything" — the exact
 * behaviour 0007 refuses an empty `conditions` list to prevent.
 */
function keywordMatches(condition: KeywordCondition, body: string | null): boolean {
  if (body === null) {
    return false;
  }

  const haystack = body.toLowerCase();

  return combine(
    condition.match,
    condition.values.map((value) => value.trim().toLowerCase()),
    (needle) => needle.length > 0 && haystack.includes(needle),
  );
}

function tagMatches(condition: TagCondition, tagIds: ReadonlySet<string> | null): boolean {
  return tagIds === null
    ? false
    : combine(condition.match, condition.tagIds, (tagId) => tagIds.has(tagId));
}

/**
 * Reads `contacts.custom_fields` and only those — never a built-in contact
 * column (0007, decision 3).
 *
 * The distinction the operators turn on is **present** versus **absent**, where
 * absent covers both a key that is not in the object and a key whose value is
 * `null`: `CustomFieldValuesSchema` types the value as `string | null`, and a
 * field cleared to null is not a field with a value.
 *
 * `is_set` and `is_not_set` answer that question directly. The three comparison
 * operators are all **false** against an absent field, `not_equals` included —
 * that is the "no data to read is false" rule applied one level down, and it is
 * what keeps `is_not_set` the single way to write "this field is empty" rather
 * than having two spellings that differ only when the contact is missing
 * entirely. 0007 does not say this in as many words; it is the reading that
 * keeps the rest of the document consistent.
 */
function contactAttributeMatches(
  condition: ContactAttributeCondition,
  customFields: Readonly<Record<string, string | null>> | null,
): boolean {
  if (customFields === null) {
    return false;
  }

  const value = customFields[condition.key] ?? null;

  switch (condition.operator) {
    case 'is_set':
      return value !== null;
    case 'is_not_set':
      return value === null;
    case 'equals':
      return value !== null && value === condition.value;
    case 'not_equals':
      return value !== null && value !== condition.value;
    case 'contains':
      // Case-insensitive, like `keyword` — one word in this grammar, one
      // meaning. A supervisor filtering on a free-text field has no reason to
      // expect `Gold` and `gold` to differ.
      return (
        value !== null &&
        condition.value !== null &&
        value.toLowerCase().includes(condition.value.toLowerCase())
      );
  }
}

/** `any` — at least one holds. `all` — every one does. */
function combine<T>(
  match: RoutingConditionMatch,
  values: readonly T[],
  holds: (value: T) => boolean,
): boolean {
  return match === 'any' ? values.some(holds) : values.every(holds);
}
