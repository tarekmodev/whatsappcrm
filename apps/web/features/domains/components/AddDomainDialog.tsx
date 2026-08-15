'use client';

import { useCallback, useState } from 'react';
import { CustomHostnameInputSchema } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { addDomainAction } from '../domains.actions';

/**
 * Claiming a hostname. Usage:
 * `<AddDomainDialog isOpen={…} onClose={…} />`.
 *
 * The field is validated against **the contract's own
 * `CustomHostnameInputSchema`**, so the console refuses exactly what the API
 * refuses and quotes the schema's own message — including the one refinement
 * that matters: an internationalised domain must be entered in punycode, because
 * a homograph accepted quietly is a phishing host we would then issue a
 * certificate for.
 *
 * One rule the browser cannot check is the hostname being under `PLATFORM_DOMAIN`
 * — that value is server-side configuration and is deliberately not published to
 * the client. It comes back as a `validation_failed` refusal and lands in the
 * form-level error slot, which `FormDialog` already renders.
 */
export function AddDomainDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const content = useContent();
  const { showToast } = useToast();
  const [hostname, setHostname] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const perform = useCallback(async () => addDomainAction({ hostname }), [hostname]);

  const onSuccess = useCallback(() => {
    setHostname('');
    setFieldError(null);
    showToast({ tone: 'success', message: content.domains.addedToast(hostname.trim()) });
    onClose();
  }, [content, hostname, onClose, showToast]);

  const { submit, isPending, formError, requestId, clearError } = useActionForm({
    perform,
    onSuccess,
  });

  return (
    <FormDialog
      isOpen={isOpen}
      title={content.domains.addTitle}
      submitLabel={content.domains.addSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onSubmit={() => {
        const parsed = CustomHostnameInputSchema.safeParse(hostname);

        if (!parsed.success) {
          // The schema's own message: it names the specific refinement that
          // failed, which is more useful than a single "that is not a hostname".
          setFieldError(parsed.error.issues[0]?.message ?? content.form.genericSubmitError);
          return;
        }

        setFieldError(null);
        submit();
      }}
      onClose={() => {
        // The value is kept: a dialog reopened after a mistyped hostname should
        // not make somebody retype the twenty characters that were right.
        setFieldError(null);
        clearError();
        onClose();
      }}
    >
      <Field
        label={content.domains.hostnameLabel}
        hint={content.domains.hostnameHint}
        error={fieldError ?? undefined}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="hostname"
            // `url` would offer to complete a full address including a scheme,
            // which is the first thing this field refuses.
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={hostname}
            onChange={(event) => {
              setHostname(event.target.value);
              setFieldError(null);
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}
