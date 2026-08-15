'use client';

import type { WorkflowCatalogResponse, WorkflowCondition } from '@whatsappcrm/contracts';
import type { WorkflowVocabulary } from '../presentation';
import { AgeConditionFields } from './AgeConditionFields';
import { AssignmentConditionFields } from './AssignmentConditionFields';
import { BusinessHoursConditionFields } from './BusinessHoursConditionFields';
import { SetConditionFields } from './SetConditionFields';
import { TagConditionFields } from './TagConditionFields';

/**
 * The controls for whichever condition type is selected. Usage:
 * `<ConditionFields condition={condition} catalog={catalog} vocabulary={vocabulary} onChange={…} />`.
 *
 * A `switch` over the discriminated union rather than a lookup table, so adding
 * an eighth condition type to the contract makes `pnpm typecheck` point here
 * instead of rendering nothing at runtime.
 */
export function ConditionFields({
  condition,
  catalog,
  vocabulary,
  error,
  onChange,
}: {
  condition: WorkflowCondition;
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  error?: string;
  onChange: (condition: WorkflowCondition) => void;
}) {
  switch (condition.type) {
    case 'ticket_status':
    case 'ticket_priority':
      return (
        <SetConditionFields
          condition={condition}
          catalog={catalog}
          error={error}
          onChange={onChange}
        />
      );

    case 'ticket_assignment':
      return (
        <AssignmentConditionFields
          condition={condition}
          vocabulary={vocabulary}
          onChange={onChange}
        />
      );

    case 'ticket_tag':
    case 'contact_tag':
      return (
        <TagConditionFields
          condition={condition}
          catalog={catalog}
          vocabulary={vocabulary}
          error={error}
          onChange={onChange}
        />
      );

    case 'ticket_age':
      return (
        <AgeConditionFields
          condition={condition}
          catalog={catalog}
          error={error}
          onChange={onChange}
        />
      );

    case 'business_hours':
      return <BusinessHoursConditionFields condition={condition} onChange={onChange} />;
  }
}
