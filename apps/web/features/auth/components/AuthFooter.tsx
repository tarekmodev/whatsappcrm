import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { LocaleToggle } from '@/components/locale/LocaleToggle';
import { TextLink } from '@/components/ui/TextLink';
import { webEnv } from '@/lib/config/env';
import { useContent } from '@/lib/content';
import { mailto } from '@/lib/mailto';
import type { Theme } from '@/lib/theme/theme';
import type { Locale } from '@/lib/locale/locale';
import styles from './AuthFooter.module.css';

/**
 * The line at the foot of a signed-out screen: how to reach a human, the
 * theme, and the language. Usage: `<AuthFooter theme={theme} locale={locale} />`
 * from the `(auth)` layout.
 *
 * This is where the theme toggle lives now. It used to float unlabelled in the
 * top-right corner of an otherwise empty page, which read as a stray glyph rather
 * than as a control; here it is a labelled control in a row of controls, with the
 * icon and the target theme's name beside it (TAR-521).
 *
 * The support address is the **operator's** (`NEXT_PUBLIC_SUPPORT_EMAIL`), not the
 * tenant's own customer support address — somebody who cannot sign in needs
 * whoever runs the deployment, and `branding.supportEmail` points the other way,
 * at the workspace's own customers. When it is unset the link is dropped rather
 * than rendered dead, which is the same rule every other surface reading it
 * follows.
 */
export function AuthFooter({ theme, locale }: { theme: Theme; locale: Locale }) {
  const content = useContent();

  return (
    <footer className={styles.footer}>
      {webEnv.supportEmail === null ? null : (
        <TextLink href={mailto(webEnv.supportEmail, content.auth.supportSubject)} isExternal>
          {content.auth.supportLink}
        </TextLink>
      )}
      <ThemeToggle initialTheme={theme} isLabelVisible />
      {/* Signed-out is where a reader most needs it: somebody who cannot read
          the sign-in form has no account to have stored a preference under.
          Gated with the console's copy, for the same reason. */}
      {webEnv.enableLocaleSwitch ? <LocaleToggle initialLocale={locale} /> : null}
    </footer>
  );
}
