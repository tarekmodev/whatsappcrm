import type { UserResponse } from '@whatsappcrm/contracts';
import styles from './AgentIdentity.module.css';

/**
 * Name plus email, as one unit. Usage: `<AgentIdentity user={user} />`.
 *
 * Extracted the moment it was needed by both the agents table and the assignment
 * report — the same pair of lines rendered twice is already a shared component.
 */
export function AgentIdentity({ user }: { user: UserResponse }) {
  return (
    <span className={styles.identity}>
      <span className={styles.name}>{user.displayName}</span>
      <span className={styles.email}>{user.email}</span>
    </span>
  );
}
