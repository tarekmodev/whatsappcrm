import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CustomFieldDefinition } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { CustomFieldsTable } from './CustomFieldsTable';
import { CustomFieldsTableSkeleton } from './CustomFieldsTable.Skeleton';

/**
 * The admin surface behind TAR-33's fourth acceptance criterion. A role that
 * cannot manage the schema is rendered no route to a mutation at all — not a
 * disabled button, not a hidden-by-CSS one.
 */

const PLAN_TIER: CustomFieldDefinition = {
  id: '0192f00c-0000-7000-8000-000000000c01',
  key: 'plan_tier',
  label: 'Plan tier',
  type: 'select',
  options: ['bronze', 'silver', 'gold'],
  position: 0,
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-06-01T09:00:00.000Z',
};

const ACCOUNT_MANAGER: CustomFieldDefinition = {
  ...PLAN_TIER,
  id: '0192f00c-0000-7000-8000-000000000c02',
  key: 'account_manager',
  label: 'Account manager',
  type: 'text',
  options: [],
  position: 1,
};

describe('CustomFieldsTable', () => {
  it('renders each definition with its key, its type and its options', () => {
    render(<CustomFieldsTable definitions={[PLAN_TIER]} canManage />);

    expect(screen.getByText('Plan tier')).toBeInTheDocument();
    expect(screen.getByText('plan_tier')).toBeInTheDocument();
    expect(screen.getByText(content.customFieldTypes.select)).toBeInTheDocument();
    expect(screen.getByText('gold')).toBeInTheDocument();
  });

  it('renders the definitions in the order it was given them', () => {
    // `position` ascending is the API's ordering and the order the profile form
    // renders — the table must not re-sort alphabetically behind it.
    render(<CustomFieldsTable definitions={[PLAN_TIER, ACCOUNT_MANAGER]} canManage />);

    const labels = screen.getAllByRole('cell').map((cell) => cell.textContent);

    expect(labels.indexOf('Plan tier')).toBeLessThan(labels.indexOf('Account manager'));
  });

  it('says so in words when a field carries no options', () => {
    render(<CustomFieldsTable definitions={[ACCOUNT_MANAGER]} canManage />);

    expect(screen.getByText(content.customFields.noOptions)).toBeInTheDocument();
  });

  it('names each row action after the field it acts on', () => {
    render(<CustomFieldsTable definitions={[PLAN_TIER]} canManage />);

    expect(
      screen.getByRole('button', { name: content.customFields.editAria('Plan tier') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.customFields.removeAria('Plan tier') }),
    ).toBeInTheDocument();
  });

  it('renders no action and no actions column for a role that may not manage the schema', () => {
    render(<CustomFieldsTable definitions={[PLAN_TIER]} canManage={false} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // The whole column is gone, not just its buttons.
    expect(
      screen.queryByRole('columnheader', { name: content.customFields.columnActions }),
    ).not.toBeInTheDocument();
  });

  it('explains an empty schema rather than rendering a blank panel', () => {
    render(<CustomFieldsTable definitions={[]} canManage />);

    expect(screen.getByText(content.customFields.emptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.customFields.emptyBody)).toBeInTheDocument();
  });
});

describe('CustomFieldsTableSkeleton', () => {
  it('announces the load exactly once, politely', () => {
    render(<CustomFieldsTableSkeleton />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.customFields.listLoading);
  });

  it('mirrors the loaded table’s column set, including the actions column', () => {
    const { unmount } = render(<CustomFieldsTable definitions={[PLAN_TIER]} canManage />);
    const loadedColumnCount = screen.getAllByRole('columnheader').length;

    unmount();
    render(<CustomFieldsTableSkeleton canManage />);

    expect(document.querySelectorAll('th')).toHaveLength(loadedColumnCount);
  });

  it('drops the actions column when the role would not get one', () => {
    render(<CustomFieldsTableSkeleton canManage={false} />);

    // Four data columns, no actions column — matching what that role's real
    // table will render, so the swap does not shift.
    expect(document.querySelectorAll('th')).toHaveLength(4);
  });
});
