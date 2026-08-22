'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Cluster } from '@/components/layout/Cluster';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import { CANNED_RESPONSE_PREVIEW_LENGTH } from '../constants';
import { previewBody } from '../presentation';
import { cannedResponseColumnMeta } from './canned-response-columns';
import {
  LazyDeleteCannedResponseDialog,
  LazyEditCannedResponseDialog,
} from './canned-response-dialogs.lazy';
import styles from './CannedResponsesTable.module.css';

/**
 * The tenant's saved replies, in the order the API returns them — ascending
 * `shortcut`, which is the order an admin scans for one. Usage:
 * `<CannedResponsesTable responses={responses} canManage />`.
 *
 * A client component because the row actions open dialogs; the data is fetched
 * on the server and passed in, so no client-side waterfall is introduced.
 *
 * `canManage` comes from the server's permission check and only decides what is
 * rendered — the server action asserts `canned_response:write` again, and the
 * API a third time.
 */

export interface CannedResponsesTableProps {
  responses: readonly CannedResponseResponse[];
  canManage: boolean;
}

export function CannedResponsesTable({ responses, canManage }: CannedResponsesTableProps) {
  const content = useContent();
  const [editing, setEditing] = useState<CannedResponseResponse | null>(null);
  const [removing, setRemoving] = useState<CannedResponseResponse | null>(null);

  const columns = useMemo<DataTableColumn<CannedResponseResponse>[]>(() => {
    const renderers: Record<string, (response: CannedResponseResponse) => ReactNode> = {
      shortcut: (response) => <code className={styles.shortcut}>{response.shortcut}</code>,
      title: (response) => <span className={styles.title}>{response.title}</span>,
      body: (response) => {
        const preview = previewBody(response.body);

        return (
          <>
            <span className={styles.body}>{preview.text}</span>
            {preview.isTruncated ? (
              <VisuallyHidden>
                {content.cannedResponses.textTruncatedAria(CANNED_RESPONSE_PREVIEW_LENGTH)}
              </VisuallyHidden>
            ) : null}
          </>
        );
      },
      // Real buttons, always visible: a hover-only row action is unreachable by
      // touch and by keyboard.
      actions: (response) => (
        <Cluster gap="1" justify="end" className={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            aria-label={content.cannedResponses.editAria(response.title)}
            onClick={() => {
              setEditing(response);
            }}
          >
            {content.cannedResponses.edit}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={content.cannedResponses.removeAria(response.title)}
            onClick={() => {
              setRemoving(response);
            }}
          >
            {content.cannedResponses.remove}
          </Button>
        </Cluster>
      ),
    };

    return cannedResponseColumnMeta(content, canManage).map((meta) => ({
      ...meta,
      render: renderers[meta.key] ?? (() => null),
    }));
  }, [canManage, content]);

  if (responses.length === 0) {
    return (
      <EmptyState
        heading={content.cannedResponses.emptyHeading}
        body={content.cannedResponses.emptyBody}
      />
    );
  }

  return (
    <>
      <DataTable
        caption={content.cannedResponses.listHeading}
        columns={columns}
        rows={responses}
        getRowKey={(response) => response.id}
      />

      {/* Dialog chunks load on first open, not on page load. */}
      {editing === null ? null : (
        <LazyEditCannedResponseDialog
          response={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {removing === null ? null : (
        <LazyDeleteCannedResponseDialog
          response={removing}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}
