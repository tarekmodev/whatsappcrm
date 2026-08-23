'use client';

import type { MouseEvent } from 'react';
import { useContent } from '@/lib/content';
import type { PipelineStage } from '../pipeline';
import styles from './PipelineRail.module.css';

/**
 * The four stages a message passes, drawn as a rail. Usage:
 * `<PipelineRail stages={pipeline.stages} />`, under the verdict line in the
 * pipeline card.
 *
 * **The connectors are the point.** Each stage's dot says what that stage is
 * doing; the line *after* it says whether anything gets past. When a stage
 * blocks, its dot goes amber and every connector after it drops to the border
 * role — so the flow visibly stops where it actually stops, and an admin reads
 * "the bot is quiet because there is nothing indexed" off the shape rather than
 * out of a list of four sentences (TAR-813).
 *
 * **No ordinal numbers on the tiles.** Numbers imply a wizard somebody steps
 * through. This is a state diagram of a path the bot walks on its own, and the
 * only thing the reader does with it is jump to the setting that changed it.
 *
 * **Colour is never the only carrier.** Every tile prints its condition in
 * words, and each link's accessible name is the label *and* the value line *and*
 * whether the flow stops there — so the rail reads the same in a screen reader,
 * in forced-colors mode, and to somebody who cannot separate amber from green.
 *
 * A client component for one reason: activating a fragment link scrolls a
 * heading into view without moving focus to it, which leaves a keyboard reader
 * at the top of the page they just left.
 */
export function PipelineRail({ stages }: { stages: readonly PipelineStage[] }) {
  const content = useContent();

  return (
    <nav aria-label={content.chatbot.railLabel}>
      {/* Ordered, because the order is the whole claim: these gates run in this
          sequence and the first failure ends the message's journey. */}
      <ol className={styles.rail}>
        {stages.map((stage) => (
          <li key={stage.id} className={styles.item} data-flowing={stage.isFlowing}>
            <a
              href={`#${stage.targetId}`}
              className={styles.tile}
              aria-label={stage.linkName}
              onClick={(event) => {
                focusStageHeading(event, stage.targetId);
              }}
            >
              {/* The dot repeats what the value line already says, so it is
                  hidden rather than described: a screen reader that announced
                  both would hear the state twice under one name. */}
              <span className={styles.marker} data-tone={stage.tone} aria-hidden="true">
                <span className={styles.dot} />
              </span>
              <span className={styles.text} aria-hidden="true">
                <span className={styles.label}>{stage.label}</span>
                <span className={styles.value}>{stage.value}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Sends focus to the card's heading, without taking the fragment navigation off
 * the browser.
 *
 * `preventScroll`, and no `preventDefault`: the anchor still writes the hash and
 * still does the scrolling, which keeps the URL shareable and the scroll
 * smoothed by whatever the platform does. All this adds is the half the browser
 * leaves out — a heading with `tabindex="-1"` (`SectionCard` sets it on any card
 * with an `id`) receiving focus, so the next Tab starts inside the card the
 * reader picked rather than back at the rail.
 *
 * **Deferred by a task, and that is the whole trick.** Navigating to a fragment
 * whose target is not focusable resets focus to the body, and that reset is part
 * of the link's default action — which runs *after* this handler. Focusing here
 * and now is undone a moment later, and the reader lands at the top of the
 * document with no way to tell why. jsdom implements none of that, so this is a
 * bug a unit test cannot see; verified in Chromium instead.
 */
function focusStageHeading(event: MouseEvent<HTMLAnchorElement>, targetId: string): void {
  const document = event.currentTarget.ownerDocument;

  document.defaultView?.setTimeout(() => {
    document.getElementById(`${targetId}-heading`)?.focus({ preventScroll: true });
  }, 0);
}
