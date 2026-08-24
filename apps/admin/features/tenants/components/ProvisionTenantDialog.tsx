'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TenantSlugSchema } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { TextInput } from '@/components/ui/TextInput';
import { TextLink } from '@/components/ui/TextLink';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';
import { provisionTenantAction } from '../tenants.actions';
import type { ProvisionOutcome } from '~/lib/api/admin';

/**
 * The one write here that is a **form** rather than a confirmation, because it
 * takes input rather than agreement (spec §2.5).
 *
 * ## `200` is not a success
 *
 * Provisioning is idempotent on the slug: `201` created the tenant, `200` means
 * one already existed and **nothing changed**. Treating the replay as a success
 * is how an operator concludes they created something they did not — so the
 * dialog stays open on `200`, says so, and offers a link to the tenant that was
 * already there. Only `201` toasts and navigates.
 *
 * The slug's help text says what the value *becomes*, not what shape it takes:
 * it is baked into the tenant's address and into every session cookie scoped to
 * that host, so it cannot be changed later.
 */
export function ProvisionTenantDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [existing, setExisting] = useState<string | null>(null);

  const candidate = slug.trim().toLowerCase();
  const isSlugValid = TenantSlugSchema.safeParse(candidate).success;
  const slugError =
    candidate.length > 0 && !isSlugValid ? content.tenants.slugInvalidError : undefined;

  const reset = useCallback(() => {
    setSlug('');
    setName('');
    setExisting(null);
  }, []);

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform: useCallback(
      async () => provisionTenantAction({ slug: candidate, name: name.trim() }),
      [candidate, name],
    ),
    onSuccess: useCallback(
      ({ created, tenant }: ProvisionOutcome) => {
        if (!created) {
          // The replay. Nothing changed, so nothing is announced and the dialog
          // stays where the operator can read why.
          setExisting(tenant.slug);
          return;
        }

        showToast({ tone: 'success', message: content.writes.provisionedToast(tenant.name) });
        reset();
        onClose();
        router.push(routes.tenant(tenant.slug));
      },
      [onClose, reset, router, showToast],
    ),
  });

  return (
    <FormDialog
      isOpen={isOpen}
      title={content.writes.provisionTitle}
      submitLabel={content.writes.provisionSubmit}
      isPending={isPending}
      isSubmitDisabled={!isSlugValid || name.trim().length === 0}
      formError={formError}
      requestId={requestId}
      onSubmit={submit}
      onClose={() => {
        clearError();
        reset();
        onClose();
      }}
    >
      <Stack gap="4">
        {existing === null ? null : (
          <Notice tone="info">
            {content.writes.provisionExistsNotice}{' '}
            <TextLink href={routes.tenant(existing)}>{content.writes.provisionExistsLink}</TextLink>
          </Notice>
        )}

        <Field
          label={content.writes.provisionSlugLabel}
          hint={content.writes.provisionSlugHint(candidate)}
          error={slugError}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              name="slug"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value);
                setExisting(null);
              }}
            />
          )}
        </Field>

        <Field label={content.writes.provisionNameLabel} isRequired>
          {({ controlId, describedBy }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              name="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
      </Stack>
    </FormDialog>
  );
}
