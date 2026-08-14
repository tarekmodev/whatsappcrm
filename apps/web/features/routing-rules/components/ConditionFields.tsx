'use client';

import type { RoutingCondition } from '@whatsappcrm/contracts';
import type { RoutingRuleVocabulary } from '../presentation';
import { BusinessHoursConditionFields } from './BusinessHoursConditionFields';
import { ContactAttributeConditionFields } from './ContactAttributeConditionFields';
import { KeywordConditionFields } from './KeywordConditionFields';
import { TagConditionFields } from './TagConditionFields';

/**
 * The controls for whichever condition type is selected. Usage:
 * `<ConditionFields condition={condition} vocabulary={vocabulary} onChange={…} />`.
 *
 * A `switch` over the discriminated union rather than a lookup table, so adding a
 * fifth condition type to the contract makes `pnpm typecheck` point here instead
 * of rendering nothing at runtime.
 */
export function ConditionFields({
  condition,
  vocabulary,
  error,
  onChange,
}: {
  condition: RoutingCondition;
  vocabulary: RoutingRuleVocabulary;
  error?: string;
  onChange: (condition: RoutingCondition) => void;
}) {
  switch (condition.type) {
    case 'keyword':
      return <KeywordConditionFields condition={condition} error={error} onChange={onChange} />;

    case 'tag':
      return (
        <TagConditionFields
          condition={condition}
          tags={vocabulary.tags}
          error={error}
          onChange={onChange}
        />
      );

    case 'business_hours':
      return <BusinessHoursConditionFields condition={condition} onChange={onChange} />;

    case 'contact_attribute':
      return (
        <ContactAttributeConditionFields
          condition={condition}
          customFields={vocabulary.customFields}
          error={error}
          onChange={onChange}
        />
      );
  }
}
