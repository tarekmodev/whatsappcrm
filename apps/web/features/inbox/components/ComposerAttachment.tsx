'use client';

import { useRef } from 'react';
import type { UploadableMediaKind } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FileInput } from '@/components/ui/FileInput';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { SkeletonBlock, SkeletonLine } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { useContent } from '@/lib/content';
import { mediaAcceptAttribute, type ComposerAttachmentValue } from '@/features/inbox/media-draft';
import { useMediaUpload } from '@/features/inbox/useMediaUpload';
import styles from './MessageComposer.module.css';

/**
 * Picks a file, checks it against WhatsApp's limits, and spends the upload —
 * yielding the `mediaId` a send names. Usage:
 *
 * ```tsx
 * <ComposerAttachment
 *   label={content.composer.attachLabel}
 *   allowedKinds={ATTACHABLE_MEDIA_KINDS}
 *   value={attachment}
 *   onChange={setAttachment}
 * />
 * ```
 *
 * One component for both callers: the free-form composer's attachment, and the
 * header of a template Meta approved with an image, a video or a document. The
 * two differ only in which kinds they accept, which is a prop.
 *
 * The file is checked against the contract's own published limits *before* the
 * upload, so a 40 MB photo is refused in the moment rather than after the bytes
 * have crossed the network twice. `useMediaUpload` owns that sequence and the
 * two races in it.
 */

/**
 * How much room the control takes.
 *
 * `field` is a form row of its own — the template send form, where picking the
 * header's media is one of several labelled steps.
 *
 * `inline` is a control in a toolbar: the label goes to screen readers only and
 * the native input is trimmed to its own button, because the browser's "No file
 * chosen" beside it is both redundant with the status line and the reason a file
 * input is as wide as a paragraph (TAR-518). Everything that makes it a native
 * file control — the keyboard, the label, the platform picker, the file name
 * announced on change — is untouched.
 */
export const COMPOSER_ATTACHMENT_VARIANTS = ['field', 'inline'] as const;
export type ComposerAttachmentVariant = (typeof COMPOSER_ATTACHMENT_VARIANTS)[number];

export interface ComposerAttachmentProps {
  label: string;
  /** Narrowed by a template header: an IMAGE header does not take a PDF. */
  allowedKinds: readonly UploadableMediaKind[];
  value: ComposerAttachmentValue;
  onChange: (value: ComposerAttachmentValue) => void;
  hint?: string;
  isDisabled?: boolean;
  variant?: ComposerAttachmentVariant;
}

export function ComposerAttachment({
  label,
  allowedKinds,
  value,
  onChange,
  hint,
  isDisabled = false,
  variant = 'field',
}: ComposerAttachmentProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { onPick, clear } = useMediaUpload({ allowedKinds, value, onChange, inputRef });
  const isInline = variant === 'inline';

  const control = (
    <Field
      label={label}
      hint={hint}
      isLabelHidden={isInline}
      error={value.status === 'failed' ? value.message : undefined}
    >
      {({ controlId, describedBy, isInvalid }) => (
        <FileInput
          id={controlId}
          ref={inputRef}
          name="attachment"
          className={isInline ? styles.attachmentInline : undefined}
          accept={mediaAcceptAttribute(allowedKinds)}
          disabled={isDisabled}
          aria-describedby={describedBy}
          aria-invalid={isInvalid}
          onChange={onPick}
        />
      )}
    </Field>
  );

  // Inline, the picked file's status sits *beside* the control rather than under
  // it: in a toolbar a second stacked line is the height this variant exists to
  // save. The status box reserves its own size either way, so picking a file
  // never moves the Send button under a cursor already heading for it.
  return isInline ? (
    <Cluster gap="2" className={styles.attachmentGroup}>
      {control}
      <AttachmentStatus value={value} onRemove={clear} />
    </Cluster>
  ) : (
    <Stack gap="2">
      {control}
      <AttachmentStatus value={value} onRemove={clear} />
    </Stack>
  );
}

/**
 * What the picked file is doing right now, in words.
 *
 * A polite live region rather than a toast: the agent is still standing on this
 * control, and "uploading" then "ready" is a running commentary on it, not the
 * result of an action they finished.
 *
 * The box keeps its height whether or not there is a file, so picking one does
 * not push the Send button down under a cursor already heading for it.
 */
function AttachmentStatus({
  value,
  onRemove,
}: {
  value: ComposerAttachmentValue;
  onRemove: () => void;
}) {
  const content = useContent();

  return (
    <div className={styles.attachmentStatus} role="status">
      {value.status === 'uploading' ? (
        <Cluster gap="2">
          <Spinner label={content.common.loading} />
          <span>{content.composer.attachUploading(value.fileName)}</span>
        </Cluster>
      ) : null}

      {/* Removal is offered for a failure too, not only for a success: a file
          that could not be uploaded blocks the send, and clearing it is how an
          agent gets back to the message they can send without it. */}
      {value.status === 'ready' || value.status === 'failed' ? (
        <Cluster gap="2" justify="between">
          <span className={styles.attachmentName}>
            {value.status === 'ready' ? content.composer.attachReady(value.fileName) : null}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={content.composer.attachRemoveAria(value.fileName)}
          >
            {content.composer.attachRemove}
          </Button>
        </Cluster>
      ) : null}
    </div>
  );
}

/**
 * Mirrors `ComposerAttachment`: a label line, the control at its own height, and
 * the same reserved status box — so an attach control arriving with the thread
 * moves nothing.
 */
export function ComposerAttachmentSkeleton({
  variant = 'field',
}: {
  variant?: ComposerAttachmentVariant;
}) {
  if (variant === 'inline') {
    return (
      <Cluster gap="2" className={styles.attachmentGroup} aria-hidden="true">
        <SkeletonLine width="7rem" height="var(--size-control-md)" />
        <div className={styles.attachmentStatus} />
      </Cluster>
    );
  }

  return (
    <Stack gap="2" aria-hidden="true">
      <SkeletonLine width="7rem" />
      <SkeletonBlock height="var(--size-touch-target)" />
      <div className={styles.attachmentStatus} />
    </Stack>
  );
}
