import type { ReactNode } from 'react';
import styles from './AuthCard.module.css';

/**
 * The framed panel a signed-out screen sits in. Usage:
 * `<AuthCard title={…} description={…}>{form}</AuthCard>`.
 *
 * It owns the page's single `<h1>`, so heading order is right by construction and
 * no auth screen hand-rolls a title block. TAR-60's login and invite-accept
 * screens use the same frame — which is what makes the whole signed-out surface
 * line up rather than three cards being three widths.
 *
 * `headingRef` exists for the screens that swap the form out for an outcome: the
 * new heading has to take focus, or focus is lost to the body the moment the
 * control the user just pressed unmounts.
 */
export function AuthCard({
  title,
  children,
  description,
  headingRef,
}: {
  title: string;
  children: ReactNode;
  description?: string;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <section className={styles.card}>
      <div className={styles.headingGroup}>
        {/* `tabIndex={-1}` makes it a focus target without putting it in the tab
            order — the same trick the `<main>` landmark uses. */}
        <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
          {title}
        </h1>
        {description === undefined ? null : <p className={styles.description}>{description}</p>}
      </div>
      {children}
    </section>
  );
}
