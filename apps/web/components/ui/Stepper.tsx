import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from './Badge';
import { Icon } from './Icon';
import styles from './Stepper.module.css';

/**
 * A sequence of steps a reader works through in order, with each step's progress
 * on screen at once. Usage:
 *
 * ```tsx
 * <Stepper label={content.whatsapp.wizardLabel} resolved={2} total={4}>
 *   <StepperStep position={1} status="done" title={…} summary={…} statusLabel={…} />
 *   <StepperStep position={2} status="current" title={…} statusLabel={…}>
 *     …the open step's body…
 *   </StepperStep>
 * </Stepper>
 * ```
 *
 * ## When this rather than a checklist or tabs
 *
 * `Tabs` is for views of the same thing, in any order. The onboarding checklist
 * is a set of independent jobs that happen to be listed. This is for work with a
 * **real dependency chain** — step 3 cannot be attempted before step 2 has
 * happened — which is why an upcoming step is drawn as not-yet-reachable rather
 * than as merely unfinished, and why exactly one step is open at a time.
 *
 * ## The four statuses, and why there is no fifth
 *
 * `done`, `current`, `upcoming`, `error`. A step mid-flight is still `current` —
 * the pending state belongs on the control the reader pressed (`Button
 * isPending`), per 0001's loading rules, and a fifth marker would say the same
 * thing a second time in a place the reader is not looking.
 *
 * `error` implies open: a step that failed is the one the reader has to deal
 * with, so it takes `aria-current="step"` exactly as `current` does.
 *
 * ## Status is never colour alone
 *
 * Every step carries its status as a `Badge` with a word in it, so the marker's
 * colour is reinforcement rather than the carrier. The marker itself is
 * `aria-hidden`; the `<ol>` announces "2 of 4" and the badge says which state it
 * is in.
 */

export const STEPPER_STATUSES = ['done', 'current', 'upcoming', 'error'] as const;
export type StepperStatus = (typeof STEPPER_STATUSES)[number];

/** The chip each status wears. Kept here so every stepper labels a state alike. */
export const STEPPER_STATUS_TONES: Record<StepperStatus, BadgeTone> = {
  done: 'success',
  current: 'accent',
  // Neutral rather than muted-by-absence: a step nobody has reached is not a
  // problem, and dressing it as one makes a four-step flow read as three faults.
  upcoming: 'neutral',
  error: 'danger',
};

export interface StepperProps {
  children: ReactNode;
  /** Names the list for a screen reader — the flow, not the current step. */
  label: string;
  /** Steps finished. Renders the progress meter above the list. */
  resolved: number;
  total: number;
  /** The meter's spoken and visible sentence, e.g. "2 of 4 done". */
  progressLabel: string;
}

export function Stepper({ children, label, resolved, total, progressLabel }: StepperProps) {
  // `total` comes from a fixed step list, so this can only divide by zero if that
  // list is emptied — in which case an empty bar is the honest answer, not `NaN%`.
  const fraction = total === 0 ? 0 : resolved / total;

  return (
    <div className={styles.stepper}>
      <div className={styles.meter}>
        <div
          className={styles.track}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={resolved}
          aria-valuetext={progressLabel}
        >
          {/* The one inline style this codebase allows: a per-instance
              measurement, turned into a width by the module file. */}
          <span
            className={styles.fill}
            style={{ '--stepper-progress': fraction } as React.CSSProperties}
          />
        </div>
        <p className={styles.count}>{progressLabel}</p>
      </div>
      {/* `role="list"`: `list-style: none` drops list semantics in Safari, and
          without them a screen reader stops announcing "2 of 4". */}
      <ol className={styles.list} role="list" aria-label={label}>
        {children}
      </ol>
    </div>
  );
}

export interface StepperStepProps {
  /** 1-based, drawn in the marker. The `<ol>` is what announces the position. */
  position: number;
  status: StepperStatus;
  title: string;
  /** The status in words, beside the title. Never left to the marker's colour. */
  statusLabel: string;
  /** One line under the title, on every step whatever its status. */
  summary?: ReactNode;
  /**
   * The step's own controls and copy. Rendered only for the open step —
   * `current` or `error` — so the caller passes it unconditionally and this
   * decides. A `done` step that still has something to show says it in
   * `summary`.
   */
  children?: ReactNode;
}

export function StepperStep({
  position,
  status,
  title,
  statusLabel,
  summary,
  children,
}: StepperStepProps) {
  const isOpen = status === 'current' || status === 'error';

  return (
    <li className={styles.item} data-status={status} aria-current={isOpen ? 'step' : undefined}>
      <div className={styles.header}>
        <span className={styles.marker} aria-hidden="true">
          {status === 'done' ? (
            <Icon name="check" size="sm" />
          ) : status === 'error' ? (
            <Icon name="alert" size="sm" />
          ) : (
            position
          )}
        </span>
        <div className={styles.headingGroup}>
          <h3 className={styles.title}>{title}</h3>
          {summary === undefined ? null : <p className={styles.summary}>{summary}</p>}
        </div>
        <Badge tone={STEPPER_STATUS_TONES[status]}>{statusLabel}</Badge>
      </div>

      {isOpen && children !== undefined ? <div className={styles.body}>{children}</div> : null}
    </li>
  );
}
