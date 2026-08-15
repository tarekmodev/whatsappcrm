import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable, DataTableSkeleton, type DataTableColumn } from './DataTable';

interface Row {
  id: string;
  name: string;
  count: number;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Amina Haddad', count: 2 },
  { id: 'b', name: 'Liang Wei', count: 5 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (row) => row.name },
  { key: 'count', header: 'Open', isNarrow: true, render: (row) => row.count },
  { key: 'actions', header: 'Actions', isHeaderHidden: true, render: () => <button>Edit</button> },
];

describe('DataTable', () => {
  it('renders a semantic table with an accessible name', () => {
    render(
      <DataTable caption="Agents" columns={COLUMNS} rows={ROWS} getRowKey={(row) => row.id} />,
    );

    expect(screen.getByRole('table', { name: 'Agents' })).toBeInTheDocument();
  });

  it('renders one column header per column, including the hidden one', () => {
    render(
      <DataTable caption="Agents" columns={COLUMNS} rows={ROWS} getRowKey={(row) => row.id} />,
    );

    expect(screen.getAllByRole('columnheader')).toHaveLength(COLUMNS.length);
    // Hidden visually, but still the column's name for a screen reader.
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
  });

  it('renders a row per record plus the header row', () => {
    render(
      <DataTable caption="Agents" columns={COLUMNS} rows={ROWS} getRowKey={(row) => row.id} />,
    );

    expect(screen.getAllByRole('row')).toHaveLength(ROWS.length + 1);
    expect(screen.getByText('Amina Haddad')).toBeInTheDocument();
  });

  it('repeats the header on each cell so the mobile card layout stays labelled', () => {
    render(
      <DataTable caption="Agents" columns={COLUMNS} rows={ROWS} getRowKey={(row) => row.id} />,
    );

    const cells = screen.getAllByRole('cell');

    expect(cells[0]).toHaveAttribute('data-label', 'Name');
    // A hidden header contributes no visible label to the stacked layout.
    expect(cells[2]).not.toHaveAttribute('data-label');
  });

  it('keeps row actions reachable as real buttons rather than hover-only affordances', () => {
    render(
      <DataTable caption="Agents" columns={COLUMNS} rows={ROWS} getRowKey={(row) => row.id} />,
    );

    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(ROWS.length);
  });

  it('flags only the rows `getRowTone` names, and leaves the rest unmarked', () => {
    // The ticket queue's overdue rule. One line from silently regressing: drop
    // the prop from the `<tr>` and nothing else in the suite would notice.
    render(
      <DataTable
        caption="Agents"
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.id}
        getRowTone={(row) => (row.count > 3 ? 'danger' : undefined)}
      />,
    );

    const rows = document.querySelectorAll('tbody tr');

    expect(rows).toHaveLength(2);
    // Amina, count 2 — under the threshold, so no attribute at all rather than
    // an empty one, which CSS would still match on `[data-tone]`.
    expect(rows[0]?.hasAttribute('data-tone')).toBe(false);
    expect(rows[1]).toHaveAttribute('data-tone', 'danger');
  });

  it('marks no row when no `getRowTone` is given, which is every other caller', () => {
    render(
      <DataTable caption="Agents" columns={COLUMNS} rows={ROWS} getRowKey={(row) => row.id} />,
    );

    expect(document.querySelectorAll('tbody tr[data-tone]')).toHaveLength(0);
  });
});

describe('DataTableSkeleton', () => {
  it('mirrors the loaded table’s column set exactly, so the swap cannot shift', () => {
    const { unmount } = render(
      <DataTable caption="Agents" columns={COLUMNS} rows={ROWS} getRowKey={(row) => row.id} />,
    );
    const loadedColumnCount = screen.getAllByRole('columnheader').length;

    unmount();

    render(<DataTableSkeleton caption="Agents" columns={COLUMNS} rowCount={ROWS.length} />);

    // `aria-hidden` on the wrapper hides it from the accessibility tree, so query
    // the DOM directly rather than by role.
    expect(document.querySelectorAll('th')).toHaveLength(loadedColumnCount);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(ROWS.length);
  });

  it('is hidden from assistive technology, leaving the polite announcement to speak', () => {
    render(<DataTableSkeleton caption="Agents" columns={COLUMNS} rowCount={3} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
