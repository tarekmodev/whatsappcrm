'use client';

import type {
  TicketPriority,
  TicketStatus,
  WorkflowAction,
  WorkflowCatalogResponse,
} from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import {
  actionParameterValues,
  labelledOptions,
  tagSelectOptions,
  withPlaceholder,
} from '../builder';
import type { WorkflowVocabulary } from '../presentation';
import { AssigneeField } from './AssigneeField';
import { NotifyActionFields } from './NotifyActionFields';

/**
 * The controls for whichever action type is selected. Usage:
 * `<ActionFields action={action} catalog={catalog} vocabulary={vocabulary} onChange={…} />`.
 *
 * A `switch` over the discriminated union rather than a lookup table, so adding
 * a sixth action type to the contract makes `pnpm typecheck` point here instead
 * of rendering nothing at runtime.
 *
 * Three of the five are a single select, so they live here rather than in three
 * files that would each be one control and a label.
 */
export function ActionFields({
  action,
  catalog,
  vocabulary,
  error,
  onChange,
}: {
  action: WorkflowAction;
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  error?: string;
  onChange: (action: WorkflowAction) => void;
}) {
  const content = useContent();
  const copy = content.workflows;

  switch (action.type) {
    case 'add_ticket_tag':
      return (
        <Field label={copy.tagLabel} error={error} isRequired>
          {({ controlId, describedBy, isInvalid }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              value={action.tagId}
              options={withPlaceholder(tagSelectOptions(vocabulary), copy.tagRequiredError)}
              onChange={(event) => {
                onChange({ ...action, tagId: event.target.value });
              }}
            />
          )}
        </Field>
      );

    case 'reassign':
      return (
        <AssigneeField
          target={action.target}
          vocabulary={vocabulary}
          error={error}
          onChange={(target) => {
            onChange({ ...action, target });
          }}
        />
      );

    case 'notify':
      return (
        <NotifyActionFields
          action={action}
          vocabulary={vocabulary}
          error={error}
          onChange={onChange}
        />
      );

    case 'set_status':
      return (
        <Field label={copy.statusLabel} isRequired>
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              value={action.status}
              options={labelledOptions(
                actionParameterValues(catalog, 'set_status', 'status'),
                content.ticketStatuses,
              )}
              onChange={(event) => {
                onChange({ ...action, status: event.target.value as TicketStatus });
              }}
            />
          )}
        </Field>
      );

    case 'set_priority':
      return (
        <Field label={copy.priorityLabel} isRequired>
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              value={action.priority}
              options={labelledOptions(
                actionParameterValues(catalog, 'set_priority', 'priority'),
                content.ticketPriorities,
              )}
              onChange={(event) => {
                onChange({ ...action, priority: event.target.value as TicketPriority });
              }}
            />
          )}
        </Field>
      );
  }
}
