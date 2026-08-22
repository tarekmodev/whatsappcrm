import { FilterBar } from '@/components/ui/FilterBar';
import { SearchFieldSkeleton } from '@/components/ui/SearchField';
import { SelectSkeleton } from '@/components/ui/Select';
import { content } from '@/content/en';

/**
 * The filter bar's placeholder, while the tag vocabulary is in flight.
 *
 * The real `FilterBar` with each control's own skeleton inside it, rather than
 * an approximation drawn from boxes: the bar, the gaps and the two width caps
 * are then the same objects at the same breakpoints, so the list below never
 * moves when the real controls arrive.
 *
 * No `LoadingAnnouncement` here on purpose: the list beside it already makes one
 * polite announcement, and two would talk over each other.
 */
export function ContactsFilterBarSkeleton() {
  return (
    <FilterBar label={content.contacts.filtersLabel}>
      <SearchFieldSkeleton />
      <SelectSkeleton variant="filter" />
    </FilterBar>
  );
}
