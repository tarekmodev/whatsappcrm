/**
 * The billing page's section anchors, named once.
 *
 * `SectionCard`'s `id` is also its scroll anchor, and TAR-515's empty state for
 * "no paid plan yet" links to the plans section on the same page — so the id is
 * now read in two files. A literal in both is a link that dies silently the day
 * somebody renames the section.
 */
export const BILLING_SECTION_IDS = {
  current: 'billing-current',
  plans: 'billing-plans',
  portal: 'billing-portal',
} as const;
