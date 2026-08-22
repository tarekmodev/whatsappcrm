import { cx } from '@/lib/cx';
import styles from './Icon.module.css';

/**
 * The one icon set. Usage: `<Icon name="inbox" />`, or `<Icon name="search" size="sm" />`.
 *
 * Inline SVG rather than a font or a dependency: it inherits `currentColor`, it
 * costs no request, and there is no icon package whose 900 unused glyphs have to
 * be tree-shaken back out.
 *
 * Every icon is decorative by construction — `aria-hidden`, with no accessible
 * name of its own. The label beside it, or the button's own `aria-label`, names
 * the control; an icon that also announced itself would say everything twice.
 */

/** Geometry only. A stroke-based 24×24 grid, so weights match across the set. */
const ICON_PATHS = {
  inbox: ['M3 12h5l2 3h4l2-3h5', 'M5.4 5.6 3 12v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6l-2.4-6.4'],
  people: [
    'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1',
    'M13 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0',
    'M17 5.2a3.5 3.5 0 0 1 0 6.6',
    'M21 19v-1a4 4 0 0 0-3-3.9',
  ],
  reports: ['M3 20h18', 'M6 20v-6', 'M12 20V6', 'M18 20v-9'],
  conversation: ['M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.4A8 8 0 1 1 21 12Z'],
  security: ['M6 10V8a6 6 0 0 1 12 0v2', 'M5 10h14v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z'],
  settings: [
    'M4 7h9',
    'M17 7h3',
    'M4 17h3',
    'M11 17h9',
    'M17 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4',
    'M7 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4',
  ],
  search: ['M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0', 'm20 20-3.7-3.7'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  /** One person, as opposed to `people`: a contact, not a team. */
  contact: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M20 20v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1'],
  ticket: [
    'M3 10V7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a2 2 0 0 0 0 4v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a2 2 0 0 0 0-4',
    'M15 7v2',
    'M15 11v2',
    'M15 15v2',
  ],
  /** An internal note — a page with lines, never the message bubble. */
  note: [
    'M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1',
    'M14 4v5h5',
    'M8 13h7',
    'M8 17h5',
  ],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18', 'M12 11.5v5', 'M12 8h.01'],
  /**
   * "Something is wrong with the thing you are looking at" (TAR-515). The
   * triangle is reserved for exactly that: `alert` is a bell, because a breached
   * ticket is somebody else's work needing attention rather than a fault, and
   * `info` is a circle, because an explanation is not a warning.
   */
  warning: [
    'M10.3 4.9 2.7 18a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.9a2 2 0 0 0-3.4 0',
    'M12 10v4',
    'M12 17.5h.01',
  ],
  /**
   * A narrowing: the empty state of a list a filter has emptied (TAR-515), and
   * the trigger that collapses a filter row's secondary groups (TAR-516). Three
   * lines that taper, deliberately unlike `menu`'s three equal ones — below
   * 48rem the mobile-menu trigger and a queue's "Filters" trigger are on screen
   * together, so a set in which the two were the same shape would be a set with
   * one glyph too few.
   */
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  /** A custom domain (TAR-29): a hostname, not a link and not a padlock. */
  globe: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
    'M3.5 9.5h17',
    'M3.5 14.5h17',
    'M12 3a14 14 0 0 1 0 18',
    'M12 3a14 14 0 0 0 0 18',
  ],
  /**
   * The onboarding checklist (TAR-407). Ticks beside rules rather than the
   * `note` page, which is this set's shape for an internal note — a checklist is
   * a sequence of things to do, not a thing somebody wrote.
   */
  checklist: ['m4 7 2 2 3-3', 'M13 8h7', 'm4 15 2 2 3-3', 'M13 16h7'],
  /**
   * The SLA alert bell (TAR-26). A bell rather than a warning triangle: the
   * triangle is this set's shape for "something is wrong with the page you are
   * on", and a breached ticket is somebody else's work needing attention.
   */
  alert: ['M18 9.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5', 'M13.8 20a2 2 0 0 1-3.6 0'],
  /**
   * Automation (TAR-27): one trigger branching into what it does. Deliberately
   * not a gear — `settings` already owns that shape — and not a lightning bolt,
   * which this set uses for nothing and reads as "fast" rather than "automatic".
   */
  automation: [
    'M7 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    'M21 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    'M21 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    'M7 6h10',
    'M5 8v8a2 2 0 0 0 2 2h10',
  ],
  /**
   * Billing (TAR-37): a payment card. Deliberately not a coin or a currency
   * glyph — this product is sold in several currencies and a `$` would be one
   * of them, and not the `ticket` shape, which is the same rounded rectangle
   * doing a different job.
   */
  billing: [
    'M3 8a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
    'M3 11h18',
    'M7 14h3',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  /** Confirms the chosen entry in a listbox or a menu; never a status tick. */
  check: ['m5 12.5 4.5 4.5L19 8'],
  /**
   * A date control's affordance. Deliberately not `reports` — that shape is a
   * bar chart, and a month grid is a header row over a page, not a measurement.
   */
  calendar: [
    'M4 7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
    'M4 10h16',
    'M8 4v4',
    'M16 4v4',
  ],
  /**
   * A row's overflow actions (TAR-517). Horizontal rather than vertical, because
   * this set already leans on vertical strokes for the rail's markers and a
   * column of three dots reads as one at row density. Drawn as three
   * zero-length strokes so the round line cap makes each dot, which keeps the
   * glyph on the same 1.75 stroke grid as the rest of the set.
   */
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  /** Opens a menu below its trigger; never mirrored, unlike the chevrons below. */
  chevronDown: ['m6 9 6 6 6-6'],
  /** Points along the reading direction; mirrored under `dir="rtl"`. */
  chevronForward: ['m9 5 7 7-7 7'],
  chevronBack: ['m15 5-7 7 7 7'],
} as const;

export type IconName = keyof typeof ICON_PATHS;
/**
 * `lg` is the state plate's size and nothing else's — an empty or error state
 * has no border left to be recognised by, so the icon carries that weight.
 */
export const ICON_SIZES = ['sm', 'md', 'lg'] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/** Icons whose meaning depends on which way the page reads. */
const DIRECTIONAL_ICONS: readonly IconName[] = ['chevronForward', 'chevronBack'];

export interface IconProps {
  name: IconName;
  size?: IconSize;
  className?: string;
}

export function Icon({ name, size = 'md', className }: IconProps) {
  return (
    <svg
      className={cx(styles.icon, className)}
      data-size={size}
      data-directional={DIRECTIONAL_ICONS.includes(name) ? 'true' : undefined}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
