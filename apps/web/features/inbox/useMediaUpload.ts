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
 *
 * ## The control follows the state, rather than each caller remembering to
 *
 * `<input type="file">` is uncontrolled: it keeps the last file until something
 * writes `value = ''`, and picking that same file again fires no `change` event
 * at all. So a parent that empties the attachment *state* without also clearing
 * the *control* leaves the two disagreeing — and the next send goes out without
 * the file the agent can still see named in the picker, under a success toast.
 * A send is the obvious way to reach that; removal and a template form resetting
 * its header are others.
 *
 * Rather than exposing a reset for every one of those to call, the effect below
 * makes `status: 'empty'` mean an empty control, always. There is one invariant
 * and one place that holds it.
 */

export interface UseMediaUploadOptions {
  allowedKinds: readonly UploadableMediaKind[];
  /** Watched, so emptying it anywhere also empties the control. */
  value: ComposerAttachmentValue;
  onChange: (value: ComposerAttachmentValue) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export interface MediaUpload {
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  clear: () => void;
}

export function useMediaUpload({
  allowedKinds,
  value,
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

  // Empty state, empty control — however the state got there. Written
  // unconditionally rather than only when the control looks non-empty: writing
  // `''` to an already-empty file input fires no event and costs nothing, and
  // the effect runs only when the status changes.
  useEffect(() => {
    if (value.status === 'empty' && inputRef.current !== null) {
      inputRef.current.value = '';
    }
  }, [value.status, inputRef]);

  const clear = useCallback(() => {
    // Only the parts a *removal* owns: invalidate any upload still in flight,
    // empty the state, and put the agent back on the control they just used.
    // Emptying the control itself is the effect's job.
    pickRef.current += 1;
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
