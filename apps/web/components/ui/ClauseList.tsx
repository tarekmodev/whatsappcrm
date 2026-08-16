import styles from './ClauseList.module.css';

/**
 * A short list of clauses that add up to one statement. Usage:
 * `<ClauseList clauses={['it is urgent', 'nobody is assigned to it']} />`.
 *
 * A list rather than one joined sentence, because the clauses combine — with
 * AND for a rule's conditions, in order for a workflow's actions — and a
 * bulleted list says so without a word. It also stays readable at 320px, where a
 * four-clause sentence would not.
 *
 * Read-only by construction: the clauses are already-formatted strings, so the
 * feature that owns the grammar owns the phrasing, and this owns only the shape.
 */
export function ClauseList({
  clauses,
  ariaLabel,
}: {
  clauses: readonly string[];
  /** Names the list when it is not already introduced by a visible heading. */
  ariaLabel?: string;
}) {
  return (
    <ul className={styles.list} aria-label={ariaLabel}>
      {clauses.map((clause, index) => (
        // Clauses carry no id of their own, and this list is read-only — never
        // reordered or filtered, so an index names the same clause every render.
        <li key={index} className={styles.item}>
          {clause}
        </li>
      ))}
    </ul>
  );
}
