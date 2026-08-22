import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import { RowActions, type RowAction } from './RowActions';

/**
 * TAR-709's rule, tested once here rather than four times across the tables that
 * use it: the destructive action is the one that carries the danger role, it is
 * last, and a third action collapses the cluster into an overflow.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/people',
}));

const EDIT: RowAction = {
  key: 'edit',
  label: 'Edit',
  accessibleName: 'Edit Priya Raman',
  onSelect: () => undefined,
};

const REMOVE: RowAction = {
  key: 'remove',
  label: 'Remove',
  accessibleName: 'Remove Priya Raman',
  isDestructive: true,
  onSelect: () => undefined,
};

/** A row inside a real table, so the focus-anchor walk has siblings to find. */
function renderInTable(rows: readonly { key: string; actions: readonly RowAction[] }[]) {
  return render(
    <main id={MAIN_CONTENT_ID} tabIndex={-1}>
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <RowActions subject="Priya Raman" actions={row.actions} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>,
  );
}

describe('RowActions', () => {
  it('renders two actions inline, the destructive one in the danger role and last', () => {
    // Written destructive-first, to prove the ordering is not the caller's.
    renderInTable([{ key: 'a', actions: [REMOVE, EDIT] }]);

    const controls = screen.getAllByRole('button');

    expect(controls.map((control) => control.getAttribute('aria-label'))).toEqual([
      'Edit Priya Raman',
      'Remove Priya Raman',
    ]);
    expect(controls[1]).toHaveAttribute('data-variant', 'dangerQuiet');
    expect(controls[0]).toHaveAttribute('data-variant', 'secondary');
  });

  it('collapses a third action into an overflow named after the row', () => {
    const reindex: RowAction = {
      key: 'reindex',
      label: 'Index again',
      accessibleName: 'Index Priya Raman again',
      onSelect: () => undefined,
    };

    renderInTable([{ key: 'a', actions: [EDIT, reindex, REMOVE] }]);

    expect(screen.getByRole('button', { name: 'Edit Priya Raman' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Index Priya Raman again' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: content.common.rowActions('Priya Raman') }));

    const opened = screen
      .getAllByRole('button')
      .map((control) => control.getAttribute('aria-label'));

    expect(opened).toContain('Index Priya Raman again');
    // The destructive entry is last inside the panel too.
    expect(opened.at(-1)).toBe('Remove Priya Raman');
  });

  it('runs the action it was given', () => {
    const onSelect = vi.fn();

    renderInTable([{ key: 'a', actions: [{ ...REMOVE, onSelect }] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Priya Raman' }));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('renders nothing when the caller holds no permission at all', () => {
    renderInTable([{ key: 'a', actions: [] }]);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

/**
 * What happens after a removal succeeds: the dialog has already returned focus to
 * the row's own button, and the revalidation then takes that row away. Without an
 * anchor the keyboard lands on `<body>`, where the next Tab starts from the
 * browser chrome rather than from the table.
 */
describe('focus after the row disappears', () => {
  it('moves to the next surviving row', () => {
    const { rerender } = renderInTable([
      { key: 'a', actions: [EDIT, REMOVE] },
      { key: 'b', actions: [EDIT, REMOVE] },
    ]);

    const [firstRowEdit] = screen.getAllByRole('button', { name: 'Edit Priya Raman' });

    firstRowEdit?.focus();

    rerender(
      <main id={MAIN_CONTENT_ID} tabIndex={-1}>
        <table>
          <tbody>
            <tr key="b">
              <td>
                <RowActions subject="Priya Raman" actions={[EDIT, REMOVE]} />
              </td>
            </tr>
          </tbody>
        </table>
      </main>,
    );

    expect(screen.getByRole('button', { name: 'Edit Priya Raman' })).toHaveFocus();
  });

  it('falls back to the main landmark when the table is now empty', () => {
    const { rerender } = renderInTable([{ key: 'a', actions: [EDIT, REMOVE] }]);

    screen.getByRole('button', { name: 'Remove Priya Raman' }).focus();

    rerender(
      <main id={MAIN_CONTENT_ID} tabIndex={-1}>
        <p>No people yet</p>
      </main>,
    );

    expect(document.getElementById(MAIN_CONTENT_ID)).toHaveFocus();
  });

  it('leaves focus alone when it was never in the row', () => {
    const { rerender } = renderInTable([
      { key: 'a', actions: [EDIT, REMOVE] },
      { key: 'b', actions: [EDIT, REMOVE] },
    ]);

    const main = document.getElementById(MAIN_CONTENT_ID);

    main?.focus();

    rerender(
      <main id={MAIN_CONTENT_ID} tabIndex={-1}>
        <table>
          <tbody>
            <tr key="b">
              <td>
                <RowActions subject="Priya Raman" actions={[EDIT, REMOVE]} />
              </td>
            </tr>
          </tbody>
        </table>
      </main>,
    );

    expect(main).toHaveFocus();
  });
});
