'use client';

import { useCallback, useRef, useState } from 'react';
import {
  BRANDING_ASSET_LIMITS,
  BRANDING_UPLOAD_FIELD,
  type BrandingAsset,
  type BrandingAssetKind,
} from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FileInput } from '@/components/ui/FileInput';
import { FormDialog } from '@/components/ui/FormDialog';
import { FormError } from '@/components/ui/FormError';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/ToastProvider';
import { Stack } from '@/components/layout/Stack';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { formatFileSize } from '@/lib/format/file-size';
import { removeBrandingAssetAction, uploadBrandingAssetAction } from '../branding.actions';
import { brandingAcceptAttribute, rejectBrandingAsset } from '../asset-validation';
import styles from './BrandingAssetCard.module.css';

/**
 * One uploadable brand asset — the logo or the favicon. Usage:
 * `<BrandingAssetCard kind="logo" label={…} hint={…} asset={branding.logo} />`.
 *
 * One component for both kinds rather than two near-identical ones: they differ
 * only in their label, their limits and the box their preview is drawn in, and
 * all three come from data. `BRANDING_ASSET_LIMITS` is read from the contract, so
 * the `accept` attribute, the size check and the error copy cannot drift apart or
 * from what the API enforces.
 *
 * ## Upload on choose, remove behind a confirmation
 *
 * Choosing a file uploads it immediately — there is no second "upload" button,
 * because a file input that has already opened the platform picker and had a file
 * chosen has captured the whole of the intent. Removing is the destructive half,
 * so it is confirmed and names what disappears.
 */

export interface BrandingAssetCardProps {
  kind: BrandingAssetKind;
  label: string;
  hint: string;
  /** `null` when the tenant has not uploaded one; the fallback is the product name. */
  asset: BrandingAsset | null;
  /** Drawn behind a transparent PNG, so a white logo is visible on a white card. */
  previewTone?: 'surface' | 'rail';
}

export function BrandingAssetCard({
  kind,
  label,
  hint,
  asset,
  previewTone = 'surface',
}: BrandingAssetCardProps) {
  const content = useContent();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false);

  const perform = useCallback(async () => {
    const form = new FormData();

    form.append('kind', kind);
    // Non-null by construction: `upload` is the only caller and it sets the file
    // before submitting. Guarded rather than asserted, because a `!` here would
    // be a runtime crash inside a click handler if that ever stopped being true.
    if (pendingFile !== null) {
      form.append(BRANDING_UPLOAD_FIELD, pendingFile);
    }

    return uploadBrandingAssetAction(form);
  }, [kind, pendingFile]);

  const onUploaded = useCallback(() => {
    setPendingFile(null);
    clearFileInput(inputRef.current);
    showToast({ tone: 'success', message: content.branding.uploadedToast(label) });
  }, [content, label, showToast]);

  const upload = useActionForm({ perform, onSuccess: onUploaded });

  const removal = useActionForm({
    perform: useCallback(async () => removeBrandingAssetAction(kind), [kind]),
    onSuccess: useCallback(() => {
      setIsConfirmingRemoval(false);
      showToast({ tone: 'success', message: content.branding.removedToast(label) });
    }, [content, label, showToast]),
  });

  const onFileChosen = useCallback(
    (file: File | null) => {
      setRejection(null);

      if (file === null) {
        setPendingFile(null);
        return;
      }

      const refusal = rejectBrandingAsset(kind, file);

      if (refusal !== null) {
        // Refused before the upload is spent, and the input is cleared so the
        // control does not keep showing a file name nothing will be done with.
        setRejection(refusalCopy(refusal, kind, label, content));
        setPendingFile(null);
        clearFileInput(inputRef.current);
        return;
      }

      setPendingFile(file);
    },
    [content, kind, label],
  );

  return (
    <Stack gap="3">
      <div className={styles.card}>
        <div className={styles.preview} data-tone={previewTone} data-kind={kind}>
          {asset === null ? (
            <p className={styles.empty}>{content.branding.noAsset}</p>
          ) : (
            /*
             * Same reason as `BrandLogo`: the optimizer caches on a URL that is
             * identical for every tenant, so one tenant's logo could be served
             * under another's. The box is reserved in the module file instead.
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.image} src={asset.path} alt="" loading="lazy" decoding="async" />
          )}
        </div>
        {asset === null ? null : <AssetMeta asset={asset} />}
      </div>

      <FormError message={upload.formError ?? removal.formError} requestId={upload.requestId} />

      <Field label={content.branding.chooseFile(label)} hint={hint} error={rejection ?? undefined}>
        {({ controlId, describedBy, isInvalid }) => (
          <FileInput
            id={controlId}
            ref={inputRef}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            accept={brandingAcceptAttribute(kind)}
            onChange={(event) => {
              onFileChosen(event.target.files?.[0] ?? null);
            }}
          />
        )}
      </Field>

      <div className={styles.actions}>
        <Button
          variant="primary"
          isPending={upload.isPending}
          // A precondition the user satisfies by choosing a file, not a
          // validation refusal — an invalid file is reported in the field above.
          disabled={pendingFile === null}
          onClick={() => {
            upload.submit();
          }}
        >
          {upload.isPending ? content.branding.uploading : content.common.save}
        </Button>
        {asset === null ? null : (
          <Button
            variant="danger"
            onClick={() => {
              setIsConfirmingRemoval(true);
            }}
          >
            {content.branding.removeAsset(label)}
          </Button>
        )}
      </div>

      {/*
        Destructive and immediate — the asset disappears from every screen in the
        tenant — so it is confirmed and the copy names what happens rather than
        asking "are you sure?".
      */}
      <FormDialog
        isOpen={isConfirmingRemoval}
        title={content.branding.removeConfirmTitle(label)}
        description={content.branding.removeConfirmBody(label)}
        submitLabel={content.branding.removeConfirm}
        submitVariant="danger"
        isPending={removal.isPending}
        formError={removal.formError}
        requestId={removal.requestId}
        onSubmit={() => {
          removal.submit();
        }}
        onClose={() => {
          setIsConfirmingRemoval(false);
          removal.clearError();
        }}
      >
        {null}
      </FormDialog>
    </Stack>
  );
}

function AssetMeta({ asset }: { asset: BrandingAsset }) {
  const content = useContent();
  const { value, unit } = formatFileSize(asset.sizeBytes);

  return (
    <p className={styles.meta}>
      {`${value} ${content.fileSizeUnits[unit]} · `}
      <RelativeTime isoTimestamp={asset.updatedAt} label={content.branding.assetsHeading} />
    </p>
  );
}

function refusalCopy(
  refusal: 'too_large' | 'wrong_type',
  kind: BrandingAssetKind,
  label: string,
  content: ReturnType<typeof useContent>,
): string {
  const limits = BRANDING_ASSET_LIMITS[kind];

  if (refusal === 'wrong_type') {
    return content.branding.wrongType(label, limits.mimeTypes.join(', '));
  }

  const { value, unit } = formatFileSize(limits.maxBytes);

  return content.branding.tooLarge(label, `${value} ${content.fileSizeUnits[unit]}`);
}

/**
 * A file input keeps its selection after a successful upload, which would leave
 * the control claiming a file is chosen when the pending state has been cleared —
 * and would stop a re-pick of the *same* file firing `change` at all.
 */
function clearFileInput(input: HTMLInputElement | null): void {
  if (input !== null) {
    input.value = '';
  }
}
