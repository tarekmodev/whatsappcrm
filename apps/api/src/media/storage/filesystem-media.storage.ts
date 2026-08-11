import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import { MediaObjectMissingError, MediaTooLargeError } from '../media.errors';
import {
  MEDIA_STORAGE_KEY_PATTERN,
  type MediaStorage,
  type StoredMediaBytes,
} from './media-storage.port';

/** Where a write lands before it is atomically moved into place. */
const STAGING_DIRECTORY = '.staging';

/**
 * The filesystem adapter — the only implementation of `MediaStorage` today.
 *
 * ## Why the filesystem, and what has to change
 *
 * ADR 0001 chose Render and took no decision on object storage; TAR-41 is the
 * story that provisions infrastructure and has not landed. Shipping the
 * pipeline against a port with a filesystem adapter is what lets the media
 * feature be finished and reviewed now, with the storage decision still open:
 * an S3-compatible adapter is three methods and a module binding, and no caller
 * changes.
 *
 * The consequence to know about, and it is not small: **this requires a durable
 * shared volume**. A container's writable layer is neither durable nor shared,
 * so on more than one replica a download served by pod B cannot see what pod A
 * wrote, and every deploy loses what came before it. `MEDIA_STORAGE_ROOT` must
 * point at a mounted volume until the object-store adapter exists. Said again
 * in the README and in `.env.example`, because it is the one way to deploy this
 * and be wrong.
 *
 * ## Writes are staged, then renamed
 *
 * Bytes go to a staging file first and are `rename`d into place only once the
 * stream has ended and the cap has held. `rename` within one filesystem is
 * atomic, so a reader never observes a half-written object, and a crash leaves
 * a stray staging file rather than a truncated one under a live key. Staging
 * lives under the same root for exactly that reason — a cross-device rename is
 * a copy, and stops being atomic.
 *
 * ## The cap is enforced on bytes seen
 *
 * Not on a `Content-Length`, which the sender chooses. The transform below
 * counts what actually arrives and destroys the stream the moment it passes the
 * ceiling, so a lying header buys the sender one chunk, not a full disk.
 */
@Injectable()
export class FilesystemMediaStorage implements MediaStorage {
  private readonly logger = new Logger(FilesystemMediaStorage.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    // Resolved once, at construction, so every path check below compares two
    // absolute paths. A relative root re-resolved per call would follow a
    // `process.chdir` — which nothing here does, and which is precisely the
    // kind of thing that is true until it is not.
    this.root = resolve(config.getOrThrow<string>('MEDIA_STORAGE_ROOT'));
  }

  async putStream(key: string, source: Readable, maxBytes: number): Promise<StoredMediaBytes> {
    const target = this.pathFor(key);
    const staged = join(this.root, STAGING_DIRECTORY, stagingName(key));

    await mkdir(dirname(staged), { recursive: true });

    const digest = createHash('sha256');
    let sizeBytes = 0;

    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            sizeBytes += chunk.length;

            if (sizeBytes > maxBytes) {
              // Thrown from inside the pipeline so it tears the whole thing
              // down — including the source, which stops a sender that ignores
              // backpressure from continuing to push at us.
              throw new MediaTooLargeError(null, maxBytes);
            }

            digest.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(staged),
      );

      await mkdir(dirname(target), { recursive: true });
      await rename(staged, target);
    } catch (error: unknown) {
      await this.discard(staged);
      throw error;
    }

    return { sizeBytes, checksumSha256: digest.digest('hex') };
  }

  async getStream(key: string): Promise<Readable> {
    const path = this.pathFor(key);

    // `stat` before opening, so a missing object is the typed error rather than
    // an `ENOENT` that surfaces as a stream `error` event after the response
    // headers have already gone out.
    const exists = await stat(path).then(
      (entry) => entry.isFile(),
      () => false,
    );

    if (!exists) {
      throw new MediaObjectMissingError(key);
    }

    return createReadStream(path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /**
   * Key → absolute path, refusing anything that is not a key this module built.
   *
   * Two checks, and the second is not redundant. The pattern rejects every
   * traversal sequence by construction — it permits no dots at all — and the
   * containment check catches the case the pattern cannot see: a root
   * containing a symlink, or a future key builder that widens the alphabet
   * without revisiting this file. A path escape here reads another tenant's
   * media, so it is worth being paranoid about in the one function that can
   * prevent it.
   */
  private pathFor(key: string): string {
    if (!MEDIA_STORAGE_KEY_PATTERN.test(key)) {
      throw new Error(`Refusing a storage key that is not of the expected shape: ${key}`);
    }

    const path = resolve(this.root, key);

    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Refusing a storage key that resolves outside the media root: ${key}`);
    }

    return path;
  }

  /**
   * Best-effort cleanup of a failed write. Logged rather than thrown: the
   * caller is already failing for a reason worth reporting, and replacing that
   * reason with "could not delete a temporary file" would hide it.
   */
  private async discard(path: string): Promise<void> {
    await rm(path, { force: true }).catch((error: unknown) => {
      this.logger.warn(
        `Could not remove the staged media file after a failed write: ${describe(error)}`,
      );
    });
  }
}

/**
 * A flat, collision-free staging name for a key.
 *
 * Flat because staging is one directory and a key contains slashes; collision-
 * free because the key already contains a UUID. Two writers racing on one key
 * would therefore share a staging file — which cannot happen, because a key
 * contains the id of a row that has just been created and belongs to one
 * caller.
 */
function stagingName(key: string): string {
  return key.replaceAll('/', '_');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
