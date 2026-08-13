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
   * The SLA alert bell (TAR-26). A bell rather than a warning triangle: the
   * triangle is this set's shape for "something is wrong with the page you are
   * on", and a breached ticket is somebody else's work needing attention.
   */
  alert: ['M18 9.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5', 'M13.8 20a2 2 0 0 1-3.6 0'],
  plus: ['M12 5v14', 'M5 12h14'],
  /** Opens a menu below its trigger; never mirrored, unlike the chevrons below. */
  chevronDown: ['m6 9 6 6 6-6'],
  /** Points along the reading direction; mirrored under `dir="rtl"`. */
  chevronForward: ['m9 5 7 7-7 7'],
  chevronBack: ['m15 5-7 7 7 7'],
} as const;

export type IconName = keyof typeof ICON_PATHS;
export const ICON_SIZES = ['sm', 'md'] as const;
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
