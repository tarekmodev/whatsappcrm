'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { CustomFieldDefinition } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Cluster } from '@/components/layout/Cluster';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { useContent } from '@/lib/content';
import { customFieldColumnMeta } from './custom-field-columns';
import {
  LazyDeleteCustomFieldDialog,
  LazyEditCustomFieldDialog,
} from './custom-field-dialogs.lazy';
import styles from './CustomFieldsTable.module.css';

/**
 * The tenant's custom field definitions, in the order they appear on a contact
 * profile. Usage: `<CustomFieldsTable definitions={definitions} canManage />`.
 *
 * A client component because the row actions open dialogs; the data is fetched on
 * the server and passed in, so no client-side waterfall is introduced.
 *
 * `canManage` comes from the server's permission check and only decides what is
 * rendered — the server action asserts `tenant:settings` again, and the API a
 * third time.
 *
 * The rows are **not** reorderable here. `position` is the API's to set through
 * `POST /custom-fields/reorder`, and a drag handle that could not call it would
 * be a control that lies. Raised as follow-up on TAR-33.
 */

export interface CustomFieldsTableProps {
  definitions: readonly CustomFieldDefinition[];
  canManage: boolean;
}

export function CustomFieldsTable({ definitions, canManage }: CustomFieldsTableProps) {
  const content = useContent();
  const [editing, setEditing] = useState<CustomFieldDefinition | null>(null);
  const [removing, setRemoving] = useState<CustomFieldDefinition | null>(null);

  const columns = useMemo<DataTableColumn<CustomFieldDefinition>[]>(() => {
    const renderers: Record<string, (definition: CustomFieldDefinition) => ReactNode> = {
      label: (definition) => <span className={styles.label}>{definition.label}</span>,
      // `dir="ltr"` and a monospace face: the key is an identifier, not prose,
      // and it is what a routing rule names.
      key: (definition) => (
        <code className={styles.key} dir="ltr">
          {definition.key}
        </code>
      ),
      type: (definition) => <Badge>{content.customFieldTypes[definition.type]}</Badge>,
      options: (definition) =>
        definition.options.length === 0 ? (
          <span className={styles.muted}>{content.customFields.noOptions}</span>
        ) : (
          <Cluster gap="2">
            {definition.options.map((option) => (
              <Badge key={option} tone="neutral">
                {option}
              </Badge>
            ))}
          </Cluster>
        ),
      // Real buttons, always visible: a hover-only row action is unreachable by
      // touch and by keyboard.
      actions: (definition) => (
        <Cluster gap="1" justify="end" className={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            aria-label={content.customFields.editAria(definition.label)}
            onClick={() => {
              setEditing(definition);
            }}
          >
            {content.customFields.edit}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={content.customFields.removeAria(definition.label)}
            onClick={() => {
              setRemoving(definition);
            }}
          >
            {content.customFields.remove}
          </Button>
        </Cluster>
      ),
    };

    return customFieldColumnMeta(content, canManage).map((meta) => ({
      ...meta,
      render: renderers[meta.key] ?? (() => null),
    }));
  }, [canManage, content]);

  if (definitions.length === 0) {
    return (
      <EmptyState
        heading={content.customFields.emptyHeading}
        body={content.customFields.emptyBody}
      />
    );
  }

  return (
    <>
      <DataTable
        caption={content.customFields.listHeading}
        columns={columns}
        rows={definitions}
        getRowKey={(definition) => definition.id}
      />

      {/* Dialog chunks load on first open, not on page load. */}
      {editing === null ? null : (
        <LazyEditCustomFieldDialog
          definition={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {removing === null ? null : (
        <LazyDeleteCustomFieldDialog
          definition={removing}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}
