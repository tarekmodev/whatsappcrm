import { Cluster } from '@/components/layout/Cluster';
import { Badge } from '@/components/ui/Badge';
import { content } from '@/content/en';
import styles from './TeamNameList.module.css';

/**
 * The teams a user belongs to, as badges. Usage:
 * `<TeamNameList teamNames={names} />`.
 *
 * Takes resolved names rather than ids, so the id → name lookup happens once per
 * page instead of once per row.
 */
export function TeamNameList({ teamNames }: { teamNames: readonly string[] }) {
  if (teamNames.length === 0) {
    return <span className={styles.none}>{content.people.noTeams}</span>;
  }

  return (
    <Cluster gap="1">
      {teamNames.map((name) => (
        <Badge key={name}>{name}</Badge>
      ))}
    </Cluster>
  );
}
