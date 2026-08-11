import { join, resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { MEDIA_MAX_BYTES } from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { InboundMediaDownloadService } from './inbound-media-download.service';
import { MediaController } from './media.controller';
import { MediaQueueRunner } from './media-queue.runner';
import { MediaReaderService } from './media-reader.service';
import { MediaSendResolver } from './media-send.resolver';
import { MediaUploadService } from './media-upload.service';
import { FilesystemMediaStorage } from './storage/filesystem-media.storage';
import { MEDIA_STORAGE } from './storage/media-storage.port';

/** Where multer writes a part before it has been validated. Under the media root. */
const UPLOAD_TEMP_DIRECTORY = '.uploads';

/**
 * The media pipeline (TAR-20e): inbound download and re-hosting, outbound
 * upload, and the reads that serve both.
 *
 * ## Layering
 *
 * An **L2 access module**, beside `WebhooksModule` and `WhatsAppModule`. It
 * imports `WhatsAppModule` for `WhatsAppMediaService`, which is the credential
 * boundary — this module never sees an access token, and
 * `WhatsAppCredentialResolver` stays private to the module that owns it.
 *
 * Nothing here imports a domain module. `WebhooksModule` does not import this
 * one either: what crosses between them is a **queue job**, enqueued by the
 * inbound writer and consumed here. That is deliberate. A direct call would
 * make ingest wait on a 100 MB transfer inside Meta's webhook timeout, and it
 * would couple two modules that have no reason to know about each other.
 *
 * `MediaSendResolver` is the one export: TAR-20c's send endpoint turns a
 * `mediaId` from a request body into a handle Meta accepts by calling it.
 * Everything else — the storage port, the upload service, the reader — stays
 * private, because a second caller of any of them would be a second place
 * tenant-scoped bytes are reached.
 *
 * ## `MulterModule.registerAsync`, and not options on the decorator
 *
 * The upload limits come from configuration, and a decorator is evaluated when
 * the class is defined — before `ConfigService` exists. Registering the module
 * asynchronously is what lets the temporary directory follow
 * `MEDIA_STORAGE_ROOT` instead of being a hard-coded `/tmp` that a read-only
 * container filesystem would reject.
 *
 * ## The two limits, and why both
 *
 * `MEDIA_MAX_BYTES` here is a transport cap — the largest any kind allows —
 * enforced by multer as the bytes arrive, so a 4 GB body is refused after
 * 100 MB rather than filling the disk. The **per-kind** limit is enforced in
 * `MediaUploadService`, once the kind is known, and it is the one a caller sees
 * quoted. A single cap could not do both: it would either let a 90 MB "image"
 * through or refuse a legitimate 40 MB document.
 */
@Module({
  imports: [
    WhatsAppModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Multer creates this directory itself and writes each part under a
        // random name — the client's file name never reaches the filesystem.
        dest: join(resolve(config.getOrThrow<string>('MEDIA_STORAGE_ROOT')), UPLOAD_TEMP_DIRECTORY),
        limits: {
          fileSize: MEDIA_MAX_BYTES,
          // One file, and nothing else. A multipart body with twenty parts, or
          // with a megabyte of form fields, is a denial-of-service shape rather
          // than a media upload.
          files: 1,
          fields: 4,
          parts: 8,
        },
      }),
    }),
  ],
  controllers: [MediaController],
  providers: [
    { provide: MEDIA_STORAGE, useClass: FilesystemMediaStorage },
    MediaUploadService,
    MediaReaderService,
    MediaSendResolver,
    InboundMediaDownloadService,
    MediaQueueRunner,
    ApiExceptionFilter,
  ],
  exports: [MediaSendResolver],
})
export class MediaModule {}
