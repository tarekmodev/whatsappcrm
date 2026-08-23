'use client';

import type { ReactNode } from 'react';
import styles from './RuleLadder.module.css';

/**
 * The gates a message has to pass, as a ladder rather than a column of fields.
 * Usage:
 *
 * ```tsx
 * <RuleLadder label={content.chatbot.ruleLadderLabel}>
 *   <Rule>
 *     <Field label="The chatbot is on" hint="Passes while…">{…}</Field>
 *   </Rule>
 * </RuleLadder>
 * ```
 *
 * **The pipeline rail's vocabulary, rotated** (TAR-813). The rail above says
 * "these four stages happen in order" with a marker and a connector; so does
 * this, for the four rules inside one stage. One language for ordering, used
 * twice, rather than a diagram at the top of the page and a plain form below it
 * that happens to be ordered too.
 *
 * What it does *not* do is imply the reader can reorder them. There is no drag
 * handle and no insertion point: the order is ADR 0010's, it is the order the bot
 * actually checks, and the ladder is a picture of that rather than a thing
 * anybody builds.
 *
 * Each rung's own content is an ordinary `Field`, so the name, the sentence, the
 * control, the error slot and the split-column layout are all the settings
 * form's — this contributes the gutter and nothing else.
 */
export function RuleLadder({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol className={styles.ladder} aria-label={label}>
      {children}
    </ol>
  );
}

/**
 * One rung. `isConfigurable={false}` marks a gate that is real but has nothing to
 * set — it draws a quieter marker, and the rung says so in words rather than
 * leaving the reader hunting for the missing control.
 */
export function Rule({
  children,
  isConfigurable = true,
}: {
  children: ReactNode;
  isConfigurable?: boolean;
}) {
  return (
    <li className={styles.rule}>
      {/* Decoration: the rung's name and sentence carry everything this says,
          and a marker announced beside them would be an empty list item. */}
      <span className={styles.marker} aria-hidden="true">
        <span className={styles.dot} data-configurable={isConfigurable} />
      </span>
      <div className={styles.body}>{children}</div>
    </li>
  );
}
