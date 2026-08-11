'use client';

import { useCallback, useEffect, useRef, type ChangeEvent, type RefObject } from 'react';
import type { UploadableMediaKind } from '@whatsappcrm/contracts';
import { useContent } from '@/lib/content';
import { formatFileSize } from '@/lib/format/file-size';
import { uploadMedia } from '@/lib/api/media-browser';
import { checkMediaFile } from '@/features/inbox/media-draft';
import { EMPTY_ATTACHMENT, type ComposerAttachmentValue } from '@/features/inbox/media-draft';

/**
 * Pick a file, check it, upload it, and report where it got to. Usage:
 *
 * ```tsx
 * const { onPick, clear } = useMediaUpload({ allowedKinds, onChange, inputRef });
 * ```
 *
 * The upload runs when the file is picked rather than when the message is sent,
 * so the wait is over before the agent has finished typing and Send is a small
 * JSON call. That is also what makes the idempotency key meaningful: retrying a
 * send never re-uploads.
 *
 * Two races, both reachable by an agent who changes their mind:
 *
 *   * **Two files in a row upload concurrently.** Without a token, the slower
 *     one lands last and the message carries the file that was replaced.
 *   * **The dialog closes mid-upload.** A resolve after unmount is a state
 *     update against a component that is gone.
 */

export interface UseMediaUploadOptions {
  allowedKinds: readonly UploadableMediaKind[];
  onChange: (value: ComposerAttachmentValue) => void;
  /** Cleared on removal, so re-picking the same file still fires `change`. */
  inputRef: RefObject<HTMLInputElement | null>;
}

export interface MediaUpload {
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  clear: () => void;
}

export function useMediaUpload({
  allowedKinds,
  onChange,
  inputRef,
}: UseMediaUploadOptions): MediaUpload {
  const content = useContent();
  const pickRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const clear = useCallback(() => {
    pickRef.current += 1;

    if (inputRef.current !== null) {
      // The control keeps the last file otherwise, so re-picking the same one
      // after a failure would fire no `change` event at all.
      inputRef.current.value = '';
    }

    onChange(EMPTY_ATTACHMENT);
    inputRef.current?.focus();
  }, [inputRef, onChange]);

  const onPick = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];

      pickRef.current += 1;
      const pick = pickRef.current;
      const isStale = (): boolean => !isMountedRef.current || pickRef.current !== pick;

      if (file === undefined) {
        onChange(EMPTY_ATTACHMENT);
        return;
      }

      const check = checkMediaFile(file, allowedKinds);

      if (check.outcome !== 'accepted') {
        onChange({
          status: 'failed',
          fileName: file.name,
          message: refusalMessage(check, content),
        });
        return;
      }

      onChange({ status: 'uploading', fileName: file.name });

      void uploadMedia(file)
        .then(({ mediaId }) => {
          if (isStale()) {
            return;
          }

          onChange({ status: 'ready', mediaId, fileName: file.name, kind: check.kind });
        })
        .catch((error: unknown) => {
          // Never swallowed: the reason belongs in the log, a readable line on
          // screen.
          console.error('Media upload failed', error);

          if (isStale()) {
            return;
          }

          onChange({
            status: 'failed',
            fileName: file.name,
            message: content.composer.attachFailed,
          });
        });
    },
    [allowedKinds, content, onChange],
  );

  return { onPick, clear };
}

/** Why WhatsApp will not carry this file, in words, with the real ceiling in it. */
function refusalMessage(
  check: Exclude<ReturnType<typeof checkMediaFile>, { outcome: 'accepted' }>,
  content: ReturnType<typeof useContent>,
): string {
  if (check.outcome === 'unsupported-type') {
    return content.composer.attachUnsupportedError;
  }

  const size = formatFileSize(check.maxBytes);

  return content.composer.attachTooLargeError(
    content.messageTypes[check.kind],
    size.value,
    content.fileSizeUnits[size.unit],
  );
}
