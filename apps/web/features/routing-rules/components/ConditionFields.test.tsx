import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CustomFieldDefinition, Tag } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ContactAttributeConditionFields } from './ContactAttributeConditionFields';
import { TagConditionFields } from './TagConditionFields';

/**
 * A rule can outlive the tag or contact field it names. The read path already says
 * so in the summary; these pin the *write* path, where a reference the editor does
 * not render is worse than one it does — it stays in the condition invisibly and
 * goes back out on every save, and the API refuses it against a form showing
 * nothing wrong.
 */

const TAG: Tag = { id: '0192f009-0000-7000-8000-000000000901', name: 'VIP', color: '#7c3aed' };
const MISSING_TAG_ID = '0192f009-0000-7000-8000-0000000009ff';

const FIELD: CustomFieldDefinition = {
  id: '0192f00a-0000-7000-8000-000000000a01',
  key: 'plan_tier',
  label: 'Plan tier',
  type: 'select',
  options: [],
  position: 0,
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-06-01T09:00:00.000Z',
};

describe('TagConditionFields', () => {
  it('keeps a deleted tag on screen, checked, so it can be removed', () => {
    const onChange = vi.fn();

    render(
      <TagConditionFields
        condition={{ type: 'tag', match: 'any', tagIds: [TAG.id, MISSING_TAG_ID] }}
        tags={[TAG]}
        onChange={onChange}
      />,
    );

    const orphan = screen.getByRole('checkbox', {
      name: content.routingRules.summaryUnknownReference,
    });

    expect(orphan).toBeChecked();
    // Same label the rule summary uses, so the two places agree.
    expect(screen.getByRole('checkbox', { name: TAG.name })).toBeChecked();
  });

  it('offers only the workspace’s tags when every reference still resolves', () => {
    render(
      <TagConditionFields
        condition={{ type: 'tag', match: 'any', tagIds: [TAG.id] }}
        tags={[TAG]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});

describe('ContactAttributeConditionFields', () => {
  it('keeps a deleted field selectable rather than showing a different one', () => {
    render(
      <ContactAttributeConditionFields
        condition={{
          type: 'contact_attribute',
          key: 'deleted_field',
          operator: 'equals',
          value: 'gold',
        }}
        customFields={[FIELD]}
        onChange={vi.fn()}
      />,
    );

    const select = screen.getByLabelText(/Contact field/);

    // The control shows what the condition actually holds — not `plan_tier`,
    // which is what rendering only the resolvable fields would have displayed.
    expect(select).toHaveValue('deleted_field');
    expect(
      screen.getByRole('option', { name: content.routingRules.summaryUnknownReference }),
    ).toBeInTheDocument();
  });

  it('lists only the workspace’s fields when the key still resolves', () => {
    render(
      <ContactAttributeConditionFields
        condition={{ type: 'contact_attribute', key: FIELD.key, operator: 'equals', value: 'gold' }}
        customFields={[FIELD]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/Contact field/)).toHaveValue(FIELD.key);
    expect(
      screen.queryByRole('option', { name: content.routingRules.summaryUnknownReference }),
    ).not.toBeInTheDocument();
  });
});
