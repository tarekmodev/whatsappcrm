'use client';

import type { MessageAttachment, MessageDirection } from '@whatsappcrm/contracts';
import { Notice } from '@/components/ui/Notice';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { formatFileSize } from '@/lib/format/file-size';
import styles from './MessageAttachment.module.css';

/**
 * One attachment on a message, rendered as the kind of thing it is. Usage:
 * `<MessageAttachmentView attachment={…} direction="inbound" caption={body} />`.
 *
 * The renderer is picked from `kind`, never from `mimeType`, because the two do
 * not agree: `image/webp` is a sticker and `image/png` is a photo, and they do
 * not render the same way.
 *
 * ## Three states, not one
 *
 * An inbound download runs off the ingest path, so a message can exist before
 * its picture does. `pending` renders a placeholder **in the same reserved box**
 * the image will occupy, so nothing moves when the bytes land; `failed` says so,
 * because the customer did send something and a silent gap would say otherwise.
 * `url: null` in any other state is treated as failed rather than rendered as a
 * broken element.
 *
 * ## Why not `next/image`
 *
 * The bytes are served from the API origin, which is per-deployment and, under a
 * white-label custom domain (TAR-29), per *tenant* — `images.remotePatterns`
 * would have to name a host set that is not known at build time. The media is
 * already re-hosted and access-controlled by the API, so the optimiser buys
 * little here. The box is reserved by aspect ratio instead, which is what
 * `next/image` would have been doing for us.
 */

export interface MessageAttachmentViewProps {
  attachment: MessageAttachment;
  direction: MessageDirection;
  /** The message body, which WhatsApp uses as the caption for a media message. */
  caption: string | null;
}

export function MessageAttachmentView({
  attachment,
  direction,
  caption,
}: MessageAttachmentViewProps) {
  const content = useContent();

  if (attachment.downloadState === 'pending') {
    return (
      <div className={styles.frame} data-kind={attachment.kind}>
        <SkeletonBlock height="100%" />
        <p className={styles.state}>{content.thread.attachmentDownloading}</p>
      </div>
    );
  }

  if (attachment.downloadState === 'failed' || attachment.url === null) {
    return <Notice tone="warning">{content.thread.attachmentFailed}</Notice>;
  }

  switch (attachment.kind) {
    case 'image':
    case 'sticker':
      return (
        <div className={styles.frame} data-kind={attachment.kind}>
          {/* eslint-disable-next-line @next/next/no-img-element -- see the
              module comment: the media origin is per-tenant at runtime, so
              `images.remotePatterns` cannot name it at build time. */}
          <img
            className={styles.media}
            src={attachment.url}
            alt={imageAlt(attachment, direction, caption, content)}
            loading="lazy"
            decoding="async"
          />
        </div>
      );

    case 'video':
      return (
        <div className={styles.frame} data-kind="video">
          {/* No autoplay, controls always, and only the metadata is fetched
              until somebody presses play. */}
          <video className={styles.media} src={attachment.url} controls preload="metadata">
            {content.thread.videoUnsupported}
          </video>
        </div>
      );

    case 'audio':
      return (
        <audio className={styles.audio} src={attachment.url} controls preload="metadata">
          {content.thread.audioUnsupported}
        </audio>
      );

    case 'document':
      return <DocumentLink attachment={attachment} url={attachment.url} />;
  }
}

function DocumentLink({
  attachment,
  url,
}: {
  attachment: MessageAttachment;
  /** Narrowed by the caller; the schema types it nullable for the pending case. */
  url: string;
}) {
  const content = useContent();
  const fileName = attachment.fileName ?? content.thread.unnamedDocument;

  return (
    <a
      className={styles.document}
      href={url}
      // A new tab because the bytes are on another origin and an in-page
      // navigation would take the agent out of the thread they are reading.
      target="_blank"
      rel="noopener noreferrer"
      aria-label={content.thread.openDocument(fileName)}
    >
      <span className={styles.documentName}>{fileName}</span>
      {attachment.sizeBytes === null ? null : (
        <span className={styles.documentMeta}>{fileSizeLabel(attachment.sizeBytes, content)}</span>
      )}
    </a>
  );
}

function fileSizeLabel(sizeBytes: number, content: ReturnType<typeof useContent>): string {
  const { value, unit } = formatFileSize(sizeBytes);

  return content.thread.fileSize(value, content.fileSizeUnits[unit]);
}

/**
 * The caption when there is one — it is what the customer wrote about the
 * picture — and a direction-aware description otherwise. Never empty: an image
 * with no accessible name is invisible to a screen reader.
 */
function imageAlt(
  attachment: MessageAttachment,
  direction: MessageDirection,
  caption: string | null,
  content: ReturnType<typeof useContent>,
): string {
  if (caption !== null && caption.trim() !== '') {
    return caption;
  }

  if (attachment.kind === 'sticker') {
    return direction === 'inbound'
      ? content.thread.stickerFromCustomer
      : content.thread.stickerFromTeam;
  }

  return direction === 'inbound' ? content.thread.imageFromCustomer : content.thread.imageFromTeam;
}
