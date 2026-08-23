'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TenantSlugSchema } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { Cluster } from '@/components/layout/Cluster';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import styles from './TenantLookupForm.module.css';

/**
 * Opens one tenant by slug. Usage: `<TenantLookupForm />`.
 *
 * ## Why this is a lookup and not a table
 *
 * The admin API has no `GET /admin/tenants`. Every tenant read on that surface
 * names one slug in its path, and the only cross-tenant list anywhere on it is
 * the custom-domain queue — which lists *domains*, and only those a tenant has
 * verified. A table here would either be inventing a list or renaming a different
 * resource, so the screen does the honest thing and says so beside this form.
 *
 * ## Why it navigates rather than submitting
 *
 * The tenant is the *route*, not a query result: `/admin/tenants/{slug}` is what
 * an operator sends to a colleague mid-incident, and what the back button has to
 * return them to. So this validates the slug and pushes — the read belongs to the
 * page it lands on, where it renders on the server behind its own boundary.
 *
 * Validation is `TenantSlugSchema`, the same object the API validates the path
 * parameter with, so a value this accepts cannot come back a `400`.
 */
export function TenantLookupForm() {
  const content = useContent();
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [slugError, setSlugError] = useState<string | undefined>(undefined);

  return (
    <form
      noValidate
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();

        const candidate = slug.trim().toLowerCase();

        if (candidate.length === 0) {
          setSlugError(content.platformAdmin.tenants.slugRequiredError);
          return;
        }

        if (!TenantSlugSchema.safeParse(candidate).success) {
          setSlugError(content.platformAdmin.tenants.slugInvalidError);
          return;
        }

        setSlugError(undefined);
        router.push(routes.adminTenant(candidate));
      }}
    >
      <Cluster gap="3" align="end" className={styles.row}>
        <div className={styles.field}>
          <Field
            label={content.platformAdmin.tenants.slugLabel}
            hint={content.platformAdmin.tenants.slugHint}
            error={slugError}
            isRequired
          >
            {({ controlId, describedBy, isInvalid }) => (
              <TextInput
                id={controlId}
                aria-describedby={describedBy}
                aria-invalid={isInvalid}
                name="slug"
                // A slug is lowercase by contract, and a phone that capitalises
                // the first letter would make every lookup from one fail.
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={slug}
                onChange={(event) => {
                  setSlug(event.target.value);
                  setSlugError(undefined);
                }}
              />
            )}
          </Field>
        </div>
        <Button type="submit" variant="primary">
          {content.platformAdmin.tenants.lookupSubmit}
        </Button>
      </Cluster>
    </form>
  );
}
