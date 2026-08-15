'use client';

import { useCallback, useState } from 'react';
import type { TenantBranding } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { TextInput } from '@/components/ui/TextInput';
import { useToast } from '@/components/ui/ToastProvider';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import type { Theme } from '@/lib/theme/theme';
import { saveBrandingAction } from '../branding.actions';
import {
  BRANDING_PRODUCT_NAME_MAX,
  BRANDING_RESET_COLOURS,
  accentReadout,
  brandingDraftFrom,
  brandingUpdateFrom,
  hasBrandingErrors,
  previewBrandingFrom,
  validateBrandingDraft,
  type BrandingDraft,
  type BrandingDraftErrors,
} from '../branding-draft';
import { ColorField } from './ColorField';
import { BrandingPreviewSkeleton } from './BrandingPreview.Skeleton';
import { LazyBrandingPreview } from './branding-widgets.lazy';
import styles from './BrandingForm.module.css';

/**
 * The identity and colour half of the branding screen. Usage:
 * `<BrandingForm branding={tenant.branding} theme={theme} />`.
 *
 * One `<form>` for four fields and one save, because they are one decision: an
 * admin picking a product name and the colour behind it is doing a single piece
 * of work, and splitting it into four autosaving controls would mean four chances
 * to half-apply a brand across every screen in the tenant.
 *
 * The preview below the fields reads the *draft*, so the colours move as they are
 * typed. It is the one lazy boundary on this page — see `branding-widgets.lazy`
 * for why the fields are not.
 *
 * `theme` comes from the server rather than being read here: the console already
 * resolved it before first paint, and re-deriving it on the client would make the
 * preview flash the wrong theme on the first frame.
 */
export function BrandingForm({ branding, theme }: { branding: TenantBranding; theme: Theme }) {
  const content = useContent();
  const { showToast } = useToast();
  // The saved record, replaced on every successful save. It is what an invalid
  // draft colour falls back to in the preview, so it has to move with the server.
  const [saved, setSaved] = useState(branding);
  const [draft, setDraft] = useState<BrandingDraft>(() => brandingDraftFrom(branding));
  const [fieldErrors, setFieldErrors] = useState<BrandingDraftErrors>({});

  const perform = useCallback(async () => saveBrandingAction(brandingUpdateFrom(draft)), [draft]);

  const onSuccess = useCallback(
    (result: TenantBranding) => {
      // Re-seeded from the server's answer rather than from the draft: the API
      // trims and normalises, and a form that kept the untrimmed text would show
      // a change the tenant does not have.
      setSaved(result);
      setDraft(brandingDraftFrom(result));
      showToast({ tone: 'success', message: content.branding.savedToast });
    },
    [content, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  const update = useCallback((patch: Partial<BrandingDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    // Cleared on edit rather than re-validated on every keystroke: telling
    // somebody their half-typed hex is invalid while they are typing it is noise.
    setFieldErrors({});
  }, []);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();

        const errors = validateBrandingDraft(draft, content.branding);

        setFieldErrors(errors);

        if (!hasBrandingErrors(errors)) {
          submit();
        }
      }}
    >
      <Stack gap="5">
        <FormError message={formError} requestId={requestId} />

        <Field
          label={content.branding.productNameLabel}
          hint={content.branding.productNameHint}
          error={fieldErrors.productName}
          isRequired
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              name="productName"
              autoComplete="organization"
              maxLength={BRANDING_PRODUCT_NAME_MAX}
              value={draft.productName}
              onChange={(event) => {
                update({ productName: event.target.value });
              }}
            />
          )}
        </Field>

        <Field
          label={content.branding.supportEmailLabel}
          hint={content.branding.supportEmailHint}
          error={fieldErrors.supportEmail}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              type="email"
              name="supportEmail"
              inputMode="email"
              autoComplete="email"
              value={draft.supportEmail}
              onChange={(event) => {
                update({ supportEmail: event.target.value });
              }}
            />
          )}
        </Field>

        <div className={styles.colours}>
          <div className={styles.colourField}>
            <ColorField
              label={content.branding.primaryColorLabel}
              hint={content.branding.primaryColorHint}
              value={draft.primaryColor}
              error={fieldErrors.primaryColor}
              onChange={(primaryColor) => {
                update({ primaryColor });
              }}
            />
            <ContrastReadout colour={draft.primaryColor} />
          </div>
          <div className={styles.colourField}>
            <ColorField
              label={content.branding.accentColorLabel}
              hint={content.branding.accentColorHint}
              value={draft.accentColor}
              error={fieldErrors.accentColor}
              onChange={(accentColor) => {
                update({ accentColor });
              }}
            />
          </div>
        </div>

        <div>
          <h3 className={styles.previewHeading}>{content.branding.previewHeading}</h3>
          <p className={styles.previewDescription}>{content.branding.previewDescription}</p>
          {/*
            `deferUntilVisible` is off: the preview is the point of the fields
            directly above it, so waiting for a scroll would leave the admin
            adjusting a colour with nothing showing the result.
          */}
          <LazyBoundary fallback={<BrandingPreviewSkeleton />}>
            <LazyBrandingPreview branding={previewBrandingFrom(draft, saved)} theme={theme} />
          </LazyBoundary>
        </div>

        <div className={styles.actions}>
          <Button type="submit" variant="primary" isPending={isPending}>
            {content.common.save}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              update(BRANDING_RESET_COLOURS);
            }}
          >
            {content.branding.resetColours}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/**
 * What this colour scores, and whether the console had to correct around it.
 *
 * Never a blocker. `brandCssVariables` guarantees AA whatever is picked, so this
 * says which of the two things happened — white text works on this colour, or we
 * switched to dark text to keep it readable — rather than refusing a value the
 * product supports.
 *
 * `aria-live` is deliberately absent: the value changes on every keystroke and on
 * every drag of the eyedropper, and announcing each one would drown the field it
 * belongs to. It is plain text beside the control, readable on demand.
 */
function ContrastReadout({ colour }: { colour: string }) {
  const content = useContent();
  const readout = accentReadout(colour);

  if (readout === null) {
    return null;
  }

  return (
    <p className={styles.contrast} data-tone={readout.isAdjusted ? 'adjusted' : 'pass'}>
      {content.branding.contrastScore(readout.ratio.toFixed(1))} ·{' '}
      {readout.isAdjusted ? content.branding.contrastAdjusted : content.branding.contrastPasses}
    </p>
  );
}
