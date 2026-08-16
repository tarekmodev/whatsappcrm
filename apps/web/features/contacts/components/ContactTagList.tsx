import type { Tag } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Cluster } from '@/components/layout/Cluster';
import { content } from '@/content/en';
import styles from './ContactTagList.module.css';

/**
 * A contact's tags, as badges. Usage: `<ContactTagList tags={contact.tags} />`.
 *
 * Shared by the directory row and the profile so the two cannot phrase an empty
 * set differently — a blank cell reads as missing data, where "No tags" reads as
 * an answer.
 *
 * `tag.color` is deliberately not rendered. `Badge`'s tones are semantic and
 * contrast-checked in both themes; a tenant-chosen hex is neither, and painting
 * one here would put arbitrary colour behind text at whatever contrast the
 * tenant happened to pick. Surfacing the colour is worth doing once there is a
 * token-backed way to do it — raised as follow-up on TAR-33.
 */
export function ContactTagList({ tags }: { tags: readonly Tag[] }) {
  if (tags.length === 0) {
    return <span className={styles.empty}>{content.contacts.noTags}</span>;
  }

  return (
    <Cluster gap="2">
      {tags.map((tag) => (
        <Badge key={tag.id}>{tag.name}</Badge>
      ))}
    </Cluster>
  );
}
