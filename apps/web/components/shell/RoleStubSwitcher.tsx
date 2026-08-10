'use client';

import { useTransition } from 'react';
import { TENANT_ROLES, type TenantRole } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useContent } from '@/lib/content';
import { setStubRoleAction } from './role-stub.actions';
import styles from './RoleStubSwitcher.module.css';

/**
 * ⚠️ INTERIM STUB (TAR-35) — rendered only when `NEXT_PUBLIC_ENABLE_ROLE_STUB` is
 * on, which is never in production. Usage: `<RoleStubSwitcher role={role} />`.
 *
 * Exists so the three role-scoped views in TAR-22's acceptance criteria can be
 * demonstrated and reviewed before real sessions land. It changes what the
 * *browser* renders; it grants nothing, because the API enforces the same
 * permission on every request regardless.
 */
export function RoleStubSwitcher({ role }: { role: TenantRole }) {
  const content = useContent();
  const [isPending, startTransition] = useTransition();

  return (
    <div className={styles.switcher}>
      <Field label={content.roleStub.label} hint={content.roleStub.hint}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            value={role}
            disabled={isPending}
            options={TENANT_ROLES.map((candidate) => ({
              value: candidate,
              label: content.roles[candidate],
            }))}
            onChange={(event) => {
              const next = event.target.value as TenantRole;

              startTransition(async () => {
                await setStubRoleAction(next);
              });
            }}
          />
        )}
      </Field>
    </div>
  );
}
