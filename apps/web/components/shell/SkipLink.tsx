import { content } from '@/content/en';
import { MAIN_CONTENT_ID } from './main-content';
import styles from './SkipLink.module.css';

/**
 * Lets a keyboard user jump past the header. Usage: `<SkipLink />` as the first
 * focusable element in the body.
 *
 * Hidden until focused, then pinned to the top of the viewport — never
 * `display: none`, which would take it out of the tab order and defeat the point.
 */
export function SkipLink() {
  return (
    <a href={`#${MAIN_CONTENT_ID}`} className={styles.skipLink}>
      {content.app.skipToContent}
    </a>
  );
}
