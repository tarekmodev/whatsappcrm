import { Module } from '@nestjs/common';
import { FilesystemMediaStorage } from './filesystem-media.storage';
import { MEDIA_STORAGE } from './media-storage.port';

/**
 * The blob store, as a module of its own so more than one bounded context can
 * bind to it (TAR-29).
 *
 * Until TAR-29 the port had exactly one consumer and lived inside
 * `MediaModule`'s provider list. Branding is the second: a tenant's logo is
 * bytes under a tenant-namespaced key, which is precisely what this port is
 * for — but it is emphatically **not** a `media_objects` row, whose kinds, mime
 * allow-list and size ceilings are Meta's Cloud API vocabulary and whose
 * retention sweep would collect a logo as unreferenced (TAR-416, "Technology
 * Choices").
 *
 * So the *port* is the reusable part and the table is not, and this module is
 * what makes that distinction structural rather than a comment. The alternative
 * — `TenancyModule` importing `MediaModule` — would drag `WhatsAppModule` and
 * the credential boundary behind it into tenant settings, which is a layering
 * inversion for the sake of one symbol.
 *
 * Not `@Global()`. Two importers is not a cross-cutting concern, and a global
 * blob store is one that any future module reaches for without anybody
 * deciding.
 */
@Module({
  providers: [{ provide: MEDIA_STORAGE, useClass: FilesystemMediaStorage }],
  exports: [MEDIA_STORAGE],
})
export class MediaStorageModule {}
