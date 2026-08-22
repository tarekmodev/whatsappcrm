import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { Icon } from '@/components/ui/Icon';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import styles from './PasswordRequirements.module.css';

/**
 * What a new password has to be, ticking as it is typed. Usage:
 * `<PasswordRequirements id={requirementsId} value={password} />` — wired to the
 * input by `PasswordField`, which points `aria-describedby` at that id.
 *
 * It replaces the sentence that used to sit under the field. A rule the user has
 * already satisfied and a rule they have not read the same in a paragraph, so the
 * only way to find out which is which is to submit and be told — which is the
 * round trip `password-policy.ts` exists to avoid (TAR-521).
 *
 * ## Where the rules come from
 *
 * `AUTH_POLICY`, the same object `PasswordSchema` is built from and the API
 * validates with. Nothing here restates a bound, so a policy change moves the
 * checklist, the hint and the server together or not at all.
 *
 * ## Why it is not a live region
 *
 * A `role="status"` here would announce the whole list on every keystroke. The
 * list is instead part of the field's description: a screen-reader user hears it
 * on arriving at the input and can re-read it, which is the same information
 * without a sentence per character. Each line carries its state in words as well
 * as in the tick, so nothing depends on the icon or its colour.
 */

export function PasswordRequirements({ id, value }: { id: string; value: string }) {
  const content = useContent();
  const requirements = [
    {
      label: content.auth.passwordMinRequirement(AUTH_POLICY.passwordMinLength),
      isMet: value.length >= AUTH_POLICY.passwordMinLength,
    },
    {
      label: content.auth.passwordMaxRequirement(AUTH_POLICY.passwordMaxLength),
      isMet: value.length > 0 && value.length <= AUTH_POLICY.passwordMaxLength,
    },
  ];

  return (
    <ul id={id} className={styles.requirements} aria-label={content.auth.passwordRequirementsLabel}>
      {requirements.map(({ label, isMet }) => (
        <li key={label} className={styles.requirement} data-met={isMet ? 'true' : 'false'}>
          <span className={styles.marker} aria-hidden="true">
            {isMet ? <Icon name="check" size="sm" /> : null}
          </span>
          {label}
          <VisuallyHidden>
            {` — ${isMet ? content.form.requirementMet : content.form.requirementUnmet}`}
          </VisuallyHidden>
        </li>
      ))}
    </ul>
  );
}
