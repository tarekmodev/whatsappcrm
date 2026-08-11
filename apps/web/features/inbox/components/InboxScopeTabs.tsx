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
 * `<InboxScopeTabs availableScopes={INBOX_SCOPES} activeScope={…} activeStatus={…} activeConversationId={…} />`.
 *
 * Both filters live in the URL: the tabs are real links, so they are shareable,
 * middle-clickable and restored by the back button.
 *
 * Changing a filter keeps the open thread open. The thread is fetched by id and
 * does not depend on the list's scope, so closing it would cost an agent their
 * place for no reason — and a conversation that has left the filtered list is
 * still one they were reading.
 */

export interface InboxScopeTabsProps {
  availableScopes: readonly InboxScope[];
  activeScope: InboxScope;
  activeStatus: ConversationStatusFilter | undefined;
  activeConversationId: string | null;
}

export function InboxScopeTabs({
  availableScopes,
  activeScope,
  activeStatus,
  activeConversationId,
}: InboxScopeTabsProps) {
  const content = useContent();
  const router = useRouter();
  const openThread = activeConversationId ?? undefined;

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
                  href={routes.inbox({
                    scope,
                    status: activeStatus,
                    conversationId: openThread,
                  })}
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
                    conversationId: openThread,
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
