'use client';

import type {
  WorkflowCatalogResponse,
  WorkflowTrigger,
  WorkflowTriggerType,
} from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import {
  MINUTES_BOUNDS,
  availableTriggerTypes,
  blankTrigger,
  triggerTypeOptions,
} from '../builder';

/**
 * When the workflow runs. Usage:
 * `<TriggerField trigger={draft.trigger} catalog={catalog} error={…} onChange={…} />`.
 *
 * One trigger per workflow, so this is a single select rather than a list — ADR
 * 0009 decision 4 makes the tenant's workflows *be* the ordered rule list, which
 * is what keeps the name, the on/off switch and the run history belonging to the
 * thing a supervisor reasons about.
 *
 * The elapsed trigger is the only one carrying a parameter, and its number field
 * appears beneath the select rather than in a second step: it is part of the same
 * sentence — "unresolved for 240 minutes" — not a separate decision.
 */
export function TriggerField({
  trigger,
  catalog,
  error,
  onChange,
}: {
  trigger: WorkflowTrigger;
  catalog: WorkflowCatalogResponse;
  error?: string;
  onChange: (trigger: WorkflowTrigger) => void;
}) {
  const content = useContent();
  const copy = content.workflows;

  return (
    <Stack gap="3">
      <Field label={copy.triggerTypeLabel} hint={copy.triggerHint} isRequired>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={trigger.type}
            options={triggerTypeOptions(availableTriggerTypes(catalog), content)}
            onChange={(event) => {
              onChange(blankTrigger(event.target.value as WorkflowTriggerType));
            }}
          />
        )}
      </Field>

      {trigger.type === 'ticket_unresolved_for' ? (
        <Field
          label={copy.minutesLabel}
          hint={copy.minutesHint(MINUTES_BOUNDS.min, MINUTES_BOUNDS.max)}
          error={error}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              // `inputMode` as well as `type`: it is what puts a numeric keypad
              // in front of somebody editing this on a phone.
              type="number"
              inputMode="numeric"
              min={MINUTES_BOUNDS.min}
              max={MINUTES_BOUNDS.max}
              step={1}
              name="minutes"
              value={String(trigger.minutes)}
              onChange={(event) => {
                onChange({ ...trigger, minutes: Number(event.target.value) });
              }}
            />
          )}
        </Field>
      ) : null}
    </Stack>
  );
}
