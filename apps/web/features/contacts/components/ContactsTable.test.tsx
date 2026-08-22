import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ContactResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { ContactsTable } from './ContactsTable';
import { ContactsTableSkeleton } from './ContactsTable.Skeleton';

/**
 * TAR-33's directory: every contact is reachable, the states that are not the
 * happy path are explained rather than left blank, and the skeleton mirrors the
 * loaded table column for column.
 */

const FATIMA: ContactResponse = {
  id: '0192f003-0000-7000-8000-000000000301',
  phone: '+966501234567',
  waProfileName: 'Fatima Al-Zahra',
  displayName: 'Fatima Al-Zahra',
  email: 'fatima@northwind.example',
  tags: [{ id: '0192f00b-0000-7000-8000-000000000b01', name: 'VIP', color: '#7c3aed' }],
  customFields: { plan_tier: 'gold' },
  lastContactedAt: '2026-08-10T08:45:00.000Z',
  optedOutAt: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-08-10T08:45:00.000Z',
};

const KARIM: ContactResponse = {
  ...FATIMA,
  id: '0192f003-0000-7000-8000-000000000305',
  phone: '+201001234567',
  waProfileName: null,
  displayName: 'Karim Nasser',
  email: null,
  tags: [],
  customFields: {},
  lastContactedAt: null,
  optedOutAt: '2026-08-09T07:00:00.000Z',
};

describe('ContactsTable', () => {
  it('renders each contact with their phone, email and tags', () => {
    render(<ContactsTable contacts={[FATIMA]} isFiltered={false} />);

    expect(screen.getByText('Fatima Al-Zahra')).toBeInTheDocument();
    expect(screen.getByText('+966501234567')).toBeInTheDocument();
    expect(screen.getByText('fatima@northwind.example')).toBeInTheDocument();
    expect(screen.getByText('VIP')).toBeInTheDocument();
  });

  it('makes the name a link to that contact’s profile', () => {
    // The row's whole affordance: a `<tr>` with a click handler is unreachable
    // by keyboard and announces nothing.
    render(<ContactsTable contacts={[FATIMA]} isFiltered={false} />);

    expect(screen.getByRole('link', { name: 'Fatima Al-Zahra' })).toHaveAttribute(
      'href',
      routes.contact(FATIMA.id),
    );
  });

  it('keeps a long email address whole for a screen reader and repeats it in `title`', () => {
    // The column is capped and the ellipsis is CSS (TAR-727). What must never be
    // true is that the value is *clipped* — gone from the DOM, or reachable by
    // nothing.
    const longEmail = 'alessandra.di-martino@northwind-support.example';

    render(<ContactsTable contacts={[{ ...FATIMA, email: longEmail }]} isFiltered={false} />);

    expect(screen.getByText(longEmail)).toHaveAttribute('title', longEmail);
  });

  it('leaves the table on the wider un-stacking threshold its five columns need', () => {
    // Un-stacked into anything narrower, the table pushed the whole document into
    // horizontal scroll between 1000px and 1090px (TAR-727).
    render(<ContactsTable contacts={[FATIMA]} isFiltered={false} />);

    expect(document.querySelectorAll('[data-unstack="wide"]')).toHaveLength(1);
  });

  it('says so in words when a contact has no email, no tags and has never been contacted', () => {
    // A blank cell reads as missing data; these read as answers.
    render(<ContactsTable contacts={[KARIM]} isFiltered={false} />);

    expect(screen.getByText(content.contacts.noEmail)).toBeInTheDocument();
    expect(screen.getByText(content.contacts.noTags)).toBeInTheDocument();
    expect(screen.getByText(content.contacts.neverContacted)).toBeInTheDocument();
  });

  it('flags an opted-out contact in text, not by colour alone', () => {
    render(<ContactsTable contacts={[KARIM]} isFiltered={false} />);

    expect(screen.getByText(content.contacts.optedOut)).toBeInTheDocument();
  });

  it('explains an empty workspace rather than rendering a blank panel', () => {
    render(<ContactsTable contacts={[]} isFiltered={false} />);

    expect(screen.getByText(content.contacts.emptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.contacts.emptyBody)).toBeInTheDocument();
  });

  it('offers a way out when a filter is what emptied the list', () => {
    // "This workspace has no contacts" and "no contact matches VIP" need
    // different copy and different next actions.
    render(<ContactsTable contacts={[]} isFiltered />);

    expect(screen.getByText(content.contacts.filteredEmptyHeading)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: content.contacts.clearFilters })).toHaveAttribute(
      'href',
      routes.contacts(),
    );
  });
});

describe('ContactsTableSkeleton', () => {
  it('announces the load exactly once, politely', () => {
    render(<ContactsTableSkeleton />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.contacts.listLoading);
  });

  it('mirrors the loaded table’s column set', () => {
    const { unmount } = render(<ContactsTable contacts={[FATIMA]} isFiltered={false} />);
    const loadedColumnCount = screen.getAllByRole('columnheader').length;

    unmount();
    render(<ContactsTableSkeleton />);

    expect(document.querySelectorAll('th')).toHaveLength(loadedColumnCount);
  });

  it('stacks on the same threshold the loaded table does', () => {
    // Otherwise the placeholder is a table at a width where the directory it
    // stands in for is still a stack of cards, and the swap reflows the page.
    render(<ContactsTableSkeleton />);

    expect(document.querySelectorAll('[data-unstack="wide"]')).toHaveLength(1);
  });
});
