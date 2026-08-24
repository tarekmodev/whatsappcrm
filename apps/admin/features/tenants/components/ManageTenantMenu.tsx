'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MenuButton } from '@/components/ui/MenuButton';
import { content } from '~/content/en';
import type { TenantWrites } from '../tenant-presentation';
import { CancelTenantDialog } from './CancelTenantDialog';
import { DeleteTenantDialog } from './DeleteTenantDialog';
import { ReactivateTenantDialog } from './ReactivateTenantDialog';
import { SuspendTenantDialog } from './SuspendTenantDialog';
import styles from './ManageTenantMenu.module.css';

/**
 * The tenant screen's header action: the four per-tenant writes behind one
 * trigger (spec §2.4).
 *
 * A menu rather than a row of buttons, because three of the four are destructive
 * and a header that put `Suspend`, `Cancel` and `Delete` side by side would make
 * destruction the loudest thing on the screen. The ordinary entry is first, the
 * irreversible one is last, and danger is carried by position as well as tone.
 *
 * **Availability is the caller's**, read from the contract's transition table —
 * so this renders what the tenant's state allows rather than deciding it. A
 * tenant in `deleted` reaches `isEmpty` and the whole menu is *omitted*, not
 * disabled: the graph has no edge out, so every entry would exist only to refuse.
 */
type OpenDialog = 'suspend' | 'reactivate' | 'cancel' | 'delete' | null;

export function ManageTenantMenu({
  slug,
  name,
  writes,
}: {
  slug: string;
  name: string;
  writes: TenantWrites;
}) {
  const [open, setOpen] = useState<OpenDialog>(null);

  if (writes.isEmpty) {
    return null;
  }

  const close = () => {
    setOpen(null);
  };

  return (
    <>
      <MenuButton
        label={
          <>
            {content.tenant.manage}
            <Icon name="chevronDown" size="sm" />
          </>
        }
        variant="control"
        align="end"
      >
        {({ close: closePanel }) => (
          <ul className={styles.list}>
            {writes.canReactivate ? (
              <li>
                <button
                  type="button"
                  className={styles.item}
                  onClick={() => {
                    closePanel();
                    setOpen('reactivate');
                  }}
                >
                  {content.writes.reactivateTitle}
                </button>
              </li>
            ) : null}
            {writes.canSuspend ? (
              <li>
                <button
                  type="button"
                  className={styles.item}
                  data-tone="danger"
                  onClick={() => {
                    closePanel();
                    setOpen('suspend');
                  }}
                >
                  {content.writes.suspendTitle}
                </button>
              </li>
            ) : null}
            {writes.canCancel ? (
              <li>
                <button
                  type="button"
                  className={styles.item}
                  data-tone="danger"
                  onClick={() => {
                    closePanel();
                    setOpen('cancel');
                  }}
                >
                  {content.writes.cancelTitle}
                </button>
              </li>
            ) : null}
            {writes.canDelete ? (
              <li>
                <button
                  type="button"
                  className={styles.item}
                  data-tone="danger"
                  onClick={() => {
                    closePanel();
                    setOpen('delete');
                  }}
                >
                  {content.writes.deleteTitle}
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </MenuButton>

      <SuspendTenantDialog slug={slug} name={name} isOpen={open === 'suspend'} onClose={close} />
      <ReactivateTenantDialog
        slug={slug}
        name={name}
        isOpen={open === 'reactivate'}
        onClose={close}
      />
      <CancelTenantDialog slug={slug} name={name} isOpen={open === 'cancel'} onClose={close} />
      <DeleteTenantDialog slug={slug} name={name} isOpen={open === 'delete'} onClose={close} />
    </>
  );
}
