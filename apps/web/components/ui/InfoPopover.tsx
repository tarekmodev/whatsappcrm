'use client';

import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { MenuButton } from './MenuButton';
import styles from './InfoPopover.module.css';

/**
 * A small "what does this number mean" affordance. Usage:
 *
 * ```tsx
 * <InfoPopover label={content.reports.metricInfoLabel(meta.label)}>
 *   {meta.methodology}
 * </InfoPopover>
 * ```
 *
 * For methodology — the sentence that says how a figure was computed. It is real
 * information a supervisor quoting the number needs, and it is not information
 * they need on screen at all times: five metric tiles each carrying three lines
 * of it is a row of paragraphs where the job is a row of numbers.
 *
 * **`MenuButton` does the work.** A popover needs `aria-expanded`, a panel the
 * trigger owns, Escape to dismiss, a press outside to dismiss, close on route
 * change and focus restored to the trigger — all of which that component already
 * owns, and a second copy of it here is exactly the drift this reuse avoids.
 * What this adds is the shape: an icon-sized trigger that sits inline beside a
 * label rather than a control standing in a row of inputs.
 *
 * The body is focused when the popover opens, which is what makes it *read* to a
 * screen reader rather than merely exist: `MenuButton` focuses the first
 * focusable node in its panel, and `tabIndex={-1}` on the paragraph makes that
 * the explanation itself. Escape then returns focus to the trigger.
 *
 * Never the only carrier of anything. What is in here explains a figure that is
 * already on screen; nothing that changes what the figure *means* belongs behind
 * a disclosure.
 */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <MenuButton
      accessibleName={label}
      label={<Icon name="info" size="sm" />}
      align="start"
      variant="icon"
    >
      <p className={styles.body} tabIndex={-1}>
        {children}
      </p>
    </MenuButton>
  );
}
