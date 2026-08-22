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

/**
 * The ids inside one plan card, derived from the plan's own key.
 *
 * Several elements in two components have to agree on them (TAR-711): the card
 * names itself from its tier *and* its price, and the checkout button points
 * `aria-describedby` at the line explaining why it cannot be pressed — a line
 * the card renders and the button does not. Derived rather than generated,
 * because the two are rendered by different components and `useId` would give
 * them different answers.
 *
 * The price is two ids rather than one paragraph, and that is not cosmetic:
 * `aria-labelledby` joins its references with a space, while name-from-content
 * over a single element concatenates its children — which runs `US$19.00` into
 * `per seat, per month`.
 */
export function planCardIds(planKey: string): {
  readonly name: string;
  readonly amount: string;
  readonly cadence: string;
  readonly allowances: string;
  readonly includes: string;
  readonly blocked: string;
} {
  return {
    name: `plan-${planKey}-name`,
    amount: `plan-${planKey}-amount`,
    cadence: `plan-${planKey}-cadence`,
    allowances: `plan-${planKey}-allowances`,
    includes: `plan-${planKey}-includes`,
    blocked: `plan-${planKey}-blocked`,
  };
}
