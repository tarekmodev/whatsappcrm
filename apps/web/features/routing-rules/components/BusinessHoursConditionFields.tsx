'use client';

import type { BusinessHoursCondition } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';

/**
 * "It arrives outside business hours." Usage: rendered by `ConditionFields` for a
 * `business_hours` condition.
 *
 * The notice is the whole reason this is not a bare toggle. A workspace with no
 * business hours configured makes this condition evaluate false whichever way it
 * is set — so the rule never matches and is silently skipped. Saying so here is
 * cheaper than a supervisor discovering it from a week of unrouted tickets.
 */
export function BusinessHoursConditionFields({
  condition,
  onChange,
}: {
  condition: BusinessHoursCondition;
  onChange: (condition: BusinessHoursCondition) => void;
}) {
  const content = useContent();
  const copy = content.routingRules;

  return (
    <>
      <Field label={copy.businessHoursLabel}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={condition.within ? WITHIN : OUTSIDE}
            options={[
              { value: WITHIN, label: copy.businessHoursWithin },
              { value: OUTSIDE, label: copy.businessHoursOutside },
            ]}
            onChange={(event) => {
              onChange({ ...condition, within: event.target.value === WITHIN });
            }}
          />
        )}
      </Field>

      <Notice tone="warning">{copy.businessHoursNotice}</Notice>
    </>
  );
}

/** `within` is a boolean on the wire; a `<select>` value is a string either way. */
const WITHIN = 'within';
const OUTSIDE = 'outside';
