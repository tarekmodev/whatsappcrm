import { describe, expect, it } from 'vitest';
import type { AgentReportRow, DurationStats } from '@whatsappcrm/contracts';
import { nextSortFor, parseAgentSort, sortAgentRows } from './agent-sort';

/**
 * The order a supervisor asked for, and the two things the obvious comparator
 * gets wrong: an unmeasured duration is not a fast one, and the unattributed row
 * is not a colleague.
 */

function stats(medianSeconds: number | null): DurationStats {
  return medianSeconds === null
    ? { count: 0, averageSeconds: null, medianSeconds: null, p90Seconds: null }
    : { count: 4, averageSeconds: medianSeconds, medianSeconds, p90Seconds: medianSeconds };
}

function row(overrides: Partial<AgentReportRow> = {}): AgentReportRow {
  return {
    userId: '0192f001-0000-7000-8000-000000000101',
    name: 'Amina Haddad',
    isActive: true,
    ticketsResolved: 3,
    firstResponse: stats(900),
    resolution: stats(8040),
    ...overrides,
  };
}

const AMINA = row();
const PRIYA = row({ userId: '0192f001-0000-7000-8000-000000000102', name: 'Priya Raman' });
const ZOE = row({ userId: '0192f001-0000-7000-8000-000000000103', name: 'Zoe Adeyemi' });

describe('reading a sort out of the URL', () => {
  it('narrows to the API’s own order rather than throwing on a hand-edited URL', () => {
    expect(parseAgentSort('salary', 'desc')).toBeUndefined();
    expect(parseAgentSort(undefined, 'desc')).toBeUndefined();
  });

  it('gives a column without a direction the one it is usually read in', () => {
    // A figure from its largest — somebody sorting by resolution time wants the
    // worst of it at the top, which is why they pressed the header.
    expect(parseAgentSort('resolution', undefined)).toEqual({
      column: 'resolution',
      direction: 'desc',
    });
    // A name from A.
    expect(parseAgentSort('agent', 'nonsense')).toEqual({ column: 'agent', direction: 'asc' });
  });
});

describe('what a header links to', () => {
  it('offers a new column in its own default order', () => {
    expect(nextSortFor('resolved', { column: 'agent', direction: 'asc' })).toEqual({
      column: 'resolved',
      direction: 'desc',
    });
  });

  it('flips the column already in force', () => {
    expect(nextSortFor('resolved', { column: 'resolved', direction: 'desc' })).toEqual({
      column: 'resolved',
      direction: 'asc',
    });
  });
});

describe('ordering the rows', () => {
  it('leaves the API’s order alone when nothing was asked for', () => {
    const rows = [ZOE, AMINA, PRIYA];

    // The same array, not a re-ranked copy: the export is serialised from this
    // order, and a console that re-sorted by default would make the two disagree.
    expect(sortAgentRows(rows, undefined)).toBe(rows);
  });

  it('sorts figures both ways', () => {
    const rows = [
      row({ userId: 'a', name: 'A', ticketsResolved: 2 }),
      row({ userId: 'b', name: 'B', ticketsResolved: 9 }),
      row({ userId: 'c', name: 'C', ticketsResolved: 5 }),
    ];

    expect(
      sortAgentRows(rows, { column: 'resolved', direction: 'desc' }).map((r) => r.name),
    ).toEqual(['B', 'C', 'A']);
    expect(
      sortAgentRows(rows, { column: 'resolved', direction: 'asc' }).map((r) => r.name),
    ).toEqual(['A', 'C', 'B']);
  });

  it('keeps an unmeasured duration last in both directions', () => {
    const rows = [
      row({ userId: 'a', name: 'A', resolution: stats(null) }),
      row({ userId: 'b', name: 'B', resolution: stats(8040) }),
      row({ userId: 'c', name: 'C', resolution: stats(900) }),
    ];

    // The point: ascending must not read "no data" as the fastest resolution in
    // the workspace and put it at the top.
    expect(
      sortAgentRows(rows, { column: 'resolution', direction: 'asc' }).map((r) => r.name),
    ).toEqual(['C', 'B', 'A']);
    expect(
      sortAgentRows(rows, { column: 'resolution', direction: 'desc' }).map((r) => r.name),
    ).toEqual(['B', 'C', 'A']);
  });

  it('keeps the unattributed row under every named one', () => {
    const unattributed = row({ userId: null, name: null, ticketsResolved: 99 });
    const rows = [unattributed, AMINA, ZOE];

    // It is not a person, it has no name to alphabetise, and it is the row that
    // makes the table add up — so it stays at the bottom whatever is sorted.
    for (const column of ['agent', 'resolved', 'resolution'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(sortAgentRows(rows, { column, direction }).at(-1)?.userId).toBeNull();
      }
    }
  });

  it('sorts names alphabetically', () => {
    expect(
      sortAgentRows([ZOE, PRIYA, AMINA], { column: 'agent', direction: 'asc' }).map((r) => r.name),
    ).toEqual(['Amina Haddad', 'Priya Raman', 'Zoe Adeyemi']);
  });

  it('leaves rows the comparator cannot separate in the order they arrived', () => {
    const rows = [
      row({ userId: 'a', name: 'A', ticketsResolved: 5 }),
      row({ userId: 'b', name: 'B', ticketsResolved: 5 }),
      row({ userId: 'c', name: 'C', ticketsResolved: 5 }),
    ];

    expect(
      sortAgentRows(rows, { column: 'resolved', direction: 'desc' }).map((r) => r.name),
    ).toEqual(['A', 'B', 'C']);
  });
});
