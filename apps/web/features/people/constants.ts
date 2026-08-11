import type { UserListQuery } from '@whatsappcrm/contracts';

/**
 * Page sizes live here rather than inline so a list, its skeleton row count and
 * its server query cannot disagree — a skeleton showing ten rows for a page of
 * twenty-five is a layout shift waiting to happen.
 */
export const AGENTS_PAGE_SIZE = 25 satisfies UserListQuery['limit'];
export const TEAMS_SKELETON_COUNT = 3;
export const CONVERSATIONS_PAGE_SIZE = 25;
export const ASSIGNMENT_ROWS_SKELETON_COUNT = 5;
