'use client';

import Link from 'next/link';
import { CONVERSATION_STATUSES } from '@whatsappcrm/contracts';
import { Cluster } from '@/components/layout/Cluster';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { routes, type ConversationStatusFilter, type InboxScope } from '@/lib/routes';
import { useRouter } from 'next/navigation';
import styles from './InboxScopeTabs.module.css';

/**
 * Scope and status filters for the inbox. Usage:
 * `<InboxScopeTabs availableScopes={scopes} activeScope={…} activeStatus={…} />`.
 *
 * `availableScopes` is computed from the principal's permissions on the server, so
 * an agent is not offered an "All conversations" tab that the API would silently
 * narrow behind their back.
 *
 * Both filters live in the URL: the tabs are real links, so they are shareable,
 * middle-clickable and restored by the back button.
 */

export interface InboxScopeTabsProps {
  availableScopes: readonly InboxScope[];
  activeScope: InboxScope;
  activeStatus: ConversationStatusFilter | undefined;
}

export function InboxScopeTabs({
  availableScopes,
  activeScope,
  activeStatus,
}: InboxScopeTabsProps) {
  const content = useContent();
  const router = useRouter();

  const scopeLabels: Record<InboxScope, string> = {
    assigned: content.inbox.scopeAssigned,
    unassigned: content.inbox.scopeUnassigned,
    all: content.inbox.scopeAll,
  };

  return (
    <Cluster justify="between" align="end" gap="3" className={styles.bar}>
      {/* A single-scope role gets no tab strip at all rather than one dead tab. */}
      {availableScopes.length > 1 ? (
        <nav aria-label={content.inbox.scopeLabel}>
          <ul className={styles.tabs}>
            {availableScopes.map((scope) => (
              <li key={scope}>
                <Link
                  href={routes.inbox({ scope, status: activeStatus })}
                  className={styles.tab}
                  aria-current={scope === activeScope ? 'page' : undefined}
                >
                  {scopeLabels[scope]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <div className={styles.status}>
        <Field label={content.inbox.statusLabel} isLabelHidden>
          {({ controlId }) => (
            <Select
              id={controlId}
              name="status"
              value={activeStatus ?? ''}
              options={[
                { value: '', label: content.common.all },
                ...CONVERSATION_STATUSES.map((status) => ({
                  value: status,
                  label: content.conversationStatuses[status],
                })),
              ]}
              onChange={(event) => {
                const next = event.target.value;

                router.replace(
                  routes.inbox({
                    scope: activeScope,
                    status: next === '' ? undefined : (next as ConversationStatusFilter),
                  }),
                  { scroll: false },
                );
              }}
            />
          )}
        </Field>
      </div>
    </Cluster>
  );
}
