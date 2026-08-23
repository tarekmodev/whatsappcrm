import { Badge } from '@/components/ui/Badge';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { content } from '@/content/en';
import { webEnv } from '@/lib/config/env';
import styles from './MockModeBadge.module.css';

/**
 * The marker the console wears while `NEXT_PUBLIC_USE_MOCK_API` is on. Usage:
 * `<MockModeBadge />` in the root layout, and nowhere else.
 *
 * A server component that renders nothing at all with the flag off, so a real
 * console pays neither markup nor JavaScript for it.
 *
 * ## Why it exists
 *
 * The mock is a *transport* (`lib/api/http.ts`): with the flag on every call in
 * the console is answered from `lib/api/mock/`, and the fixtures deliberately
 * reuse the seed dataset's names and ids so that switching modes does not
 * renumber anything. The cost of that fidelity is that a mocked console and a
 * real one look identical — TAR-830 was a tester reading a WABA phone number the
 * mock hardcodes and reporting it as a live bug. This is the one difference the
 * reader can see, and it is deliberately unmissable rather than tasteful.
 *
 * ## Why the root layout and not the shell
 *
 * The flag governs the signed-out surface too: `/login` reads its branding
 * through the same transport. A marker mounted in `(app)` would leave every
 * `(auth)` screen looking real, so it sits above both route groups.
 *
 * The badge is not a control. It takes no clicks (`pointer-events: none`) and
 * sits below the drawer, the modal and the toast — an ambient fact about the
 * environment never outranks something the reader asked for.
 */
export function MockModeBadge() {
  if (!webEnv.useMockApi) {
    return null;
  }

  return (
    <div className={styles.marker}>
      <Badge tone="warning" size="sm" className={styles.badge}>
        {content.mockNotice.label}
        {/* "Mock data" names the state; it does not say the state covers every
            request on the screen. The sentence that does is clipped rather than
            dropped, so a screen reader gets the whole fact and the corner keeps
            its two words. */}
        <VisuallyHidden>{content.mockNotice.description}</VisuallyHidden>
      </Badge>
    </div>
  );
}
