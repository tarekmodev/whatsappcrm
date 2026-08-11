import { Injectable } from '@nestjs/common';
import { WhatsAppMediaService } from '../whatsapp/whatsapp-media.service';
import { MediaReaderService, type MediaObjectRecord } from './media-reader.service';

/**
 * A stored media object, as the Cloud API client wants it named.
 *
 * Mirrors `MediaReference`'s `{ mediaId }` arm rather than importing it: this
 * module is below `WhatsAppModule`'s send path in the call graph, and a shared
 * two-field type is not worth the coupling.
 */
export interface ResolvedOutboundMedia {
  /** Meta's handle, valid for this phone number and not for long. Use once. */
  readonly mediaId: string;
}

/**
 * Turns one of our media ids into one of Meta's, for a send.
 *
 * ## Why the send path needs this at all
 *
 * `POST /api/v1/media` returns *our* row id. Meta's `sendMedia` wants either a
 * public link or *Meta's* handle. A public link is not an option — the bytes
 * are tenant-scoped and a URL Meta can fetch is a URL anyone can fetch — so the
 * bytes are uploaded to Meta at send time and the handle it returns is used
 * immediately.
 *
 * This is the seam TAR-20c's send endpoint calls. Without it, that story would
 * have to reach into the media module's storage and credentials itself, which
 * is the coupling this whole arrangement exists to prevent.
 *
 * ## Uploaded per send, never cached
 *
 * Meta's handle is scoped to the phone number that uploaded it and expires on
 * Meta's own schedule. Caching one would be a per-number, time-limited cache
 * whose staleness is discovered by a customer not receiving a message, in
 * exchange for saving an upload on the rare occasion the same file is sent
 * twice. Not a trade worth making.
 *
 * ## The buffer, and what replaces it
 *
 * `FormData` needs a `Blob`, so the object is read into memory for the upload —
 * up to 100 MB for a document, once per send. Acceptable at this scale and
 * bounded by the same limits the upload enforced, but it is the one part of
 * this pipeline that does not stream, and it is worth removing when the
 * object-store adapter lands: an S3-backed object can be handed to `fetch` as a
 * stream, and a filesystem-backed one through `openAsBlob`. Recorded in the
 * story's follow-ups rather than left to be discovered under load.
 */
@Injectable()
export class MediaSendResolver {
  constructor(
    private readonly reader: MediaReaderService,
    private readonly whatsappMedia: WhatsAppMediaService,
  ) {}

  /**
   * What a stored object *is*, without fetching its bytes or touching Meta.
   *
   * The send endpoint (TAR-68) needs this before it creates a message row: a
   * `mediaId` that names nothing, or names a document the caller declared as an
   * image, has to be a `validation_failed` while the composer is still open —
   * not a message that goes `queued` and then `failed` several seconds later
   * for a reason the agent cannot see.
   *
   * Exposed here rather than by exporting `MediaReaderService`, so
   * `ConversationsModule` gains one method against the send seam it already
   * depends on instead of a second route into this module's storage.
   *
   * Throws `MediaNotFoundError` for an id the tenant in scope does not own,
   * which is also what it throws for one that does not exist.
   */
  async describeForSend(mediaId: string): Promise<MediaObjectRecord> {
    return this.reader.describe(mediaId);
  }

  /**
   * @param mediaId our `media_objects.id`, as a send request names it
   * @param whatsappAccountId the number the message will be sent from
   *
   * Throws `MediaNotFoundError` for an id the tenant in scope does not own —
   * which is also what it throws for one that does not exist, because the two
   * must be indistinguishable.
   */
  async resolveForSend(mediaId: string, whatsappAccountId: string): Promise<ResolvedOutboundMedia> {
    const { media, body } = await this.reader.read(mediaId);

    const chunks: Buffer[] = [];

    for await (const chunk of body) {
      chunks.push(chunk as Buffer);
    }

    const providerMediaId = await this.whatsappMedia.uploadOutbound({
      whatsappAccountId,
      file: new Blob([Buffer.concat(chunks)], { type: media.mimeType }),
      mimeType: media.mimeType,
      // Meta records a name for the part. Ours is the sanitised one from the
      // upload, or the row id — never an empty string, which Meta rejects.
      fileName: media.fileName ?? media.id,
    });

    return { mediaId: providerMediaId };
  }
}
