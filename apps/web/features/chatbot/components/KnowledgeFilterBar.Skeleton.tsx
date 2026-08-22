import { FilterBar } from '@/components/ui/FilterBar';
import { SearchFieldSkeleton } from '@/components/ui/SearchField';
import { SelectSkeleton } from '@/components/ui/Select';
import { content } from '@/content/en';

/**
 * The filter row's placeholder, while the first read decides whether there is a
 * knowledge base to filter.
 *
 * The real `FilterBar` with each control's own skeleton inside it, rather than
 * an approximation drawn from boxes: the bar, the gaps and the two width caps
 * are then the same objects at the same breakpoints, so the table below never
 * moves when the real controls arrive.
 *
 * A first-mount artefact only. The boundary it falls back from is unkeyed, so on
 * a filter navigation React keeps the mounted bar on screen while the new payload
 * streams — this never flashes while somebody is typing.
 *
 * No `LoadingAnnouncement` here on purpose: the table beside it already makes one
 * polite announcement, and two would talk over each other.
 */
export function KnowledgeFilterBarSkeleton() {
  return (
    <FilterBar label={content.chatbot.knowledgeFiltersLabel}>
      <SearchFieldSkeleton />
      <SelectSkeleton variant="filter" />
    </FilterBar>
  );
}
