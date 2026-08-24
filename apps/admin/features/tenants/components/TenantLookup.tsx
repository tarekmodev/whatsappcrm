'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { TenantSlugSchema } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/SearchField';
import { Cluster } from '@/components/layout/Cluster';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';
import styles from './TenantLookup.module.css';

/**
 * Region 1 of the Tenants screen: open one tenant by slug (spec §2.3).
 *
 * ## Why this is a lookup and not a table
 *
 * There is no `GET /v1/admin/tenants`. Every tenant read on the admin surface
 * names one slug in its path, and the only cross-tenant list anywhere on it is
 * the domain queue below. A table here would either be inventing a list or
 * renaming a different resource — so the card says so in the product, not only in
 * the spec: an operator who does not know the list is missing reads the screen as
 * broken.
 *
 * **When `GET /v1/admin/tenants` lands it replaces this component and nothing
 * else** (spec §2.3). The field becomes that table's `SearchField`; region 2 stays
 * where it is. That is why this is its own component rather than markup in the page.
 *
 * ## Why it navigates rather than submitting
 *
 * The tenant is the *route*: `/tenants/{slug}` is what an operator sends to a
 * colleague mid-incident and what the back button has to return them to. So this
 * validates and pushes; the read belongs to the page it lands on, which renders
 * the 404 with the slug quoted back.
 *
 * The submit is disabled until the field validates against `TenantSlugSchema` —
 * the one legitimate disabled submit here, because the reader fixes it on this
 * screen (spec §2.3).
 *
 * The label is hidden, which is `SearchField`'s own default. The card is headed
 * "Open a tenant" and the placeholder shows a slug, so nothing is lost — and a
 * visible label above the control would put the two buttons beside it out of line
 * with the box they act on, because `Field` stacks the label above the control.
 * It is still the control's accessible name.
 */
export function TenantLookup({ provisionAction }: { provisionAction?: ReactNode }) {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [isNavigating, setIsNavigating] = useState(false);

  const candidate = slug.trim().toLowerCase();
  const isValid = TenantSlugSchema.safeParse(candidate).success;
  // Only after the operator has typed something: an empty field is not an error,
  // it is the resting state.
  const error = candidate.length > 0 && !isValid ? content.tenants.slugInvalidError : undefined;

  return (
    <form
      noValidate
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();

        if (!isValid) {
          return;
        }

        setIsNavigating(true);
        router.push(routes.tenant(candidate));
      }}
    >
      <Cluster gap="3" align="start" className={styles.row}>
        <div className={styles.field}>
          <SearchField
            name="slug"
            label={content.tenants.slugLabel}
            placeholder={content.tenants.slugPlaceholder}
            error={error}
            value={slug}
            onChange={setSlug}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={!isValid}
          isPending={isNavigating}
          pendingLabel={content.tenants.opening}
        >
          {content.tenants.open}
        </Button>
        {/* §2.3 puts this beside the field, not under it: it is the other thing
            an operator does from this card, not a third row of the same form. */}
        {provisionAction}
      </Cluster>
    </form>
  );
}
