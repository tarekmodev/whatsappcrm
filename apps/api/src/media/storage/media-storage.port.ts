import type { Readable } from 'node:stream';

/**
 * Where media bytes live, as a port (TAR-39, hexagonal boundary — the domain
 * sits at the centre, storage is an adapter).
 *
 * Three methods and no more. Everything the pipeline needs is "put these bytes
 * under this key", "give them back", "forget them" — no listing, no metadata,
 * no signed URLs. That is not minimalism for its own sake: it is what makes the
 * S3-compatible adapter TAR-41 will add a straight second implementation rather
 * than a second design. A `getSignedUrl` on this interface, for instance, would
 * have no honest filesystem answer and would leak the object store into the
 * service that calls it.
 *
 * ## Keys
 *
 * A key is an opaque, slash-separated path this module builds
 * (`media-object-key.ts`) and never takes from a request. Every adapter
 * validates it anyway — a filesystem adapter that trusted its caller is one
 * refactor away from a path traversal, and defence in depth is cheaper than the
 * incident.
 *
 * ## Streams, not buffers
 *
 * A document may be 100 MB. Buffering one in a worker is a memory spike per
 * concurrent job, and buffering one per concurrent HTTP download is an outage.
 * Both directions stream, and `putStream` reports what it actually wrote so the
 * caller can record the size and digest it observed rather than the ones it was
 * promised.
 */
export interface MediaStorage {
  /**
   * Writes `source` under `key`, replacing anything already there, and returns
   * what was written.
   *
   * Rejects with `MediaTooLargeError` if the stream exceeds `maxBytes` — the cap
   * is enforced here, on the byte count observed, rather than on a
   * `Content-Length` the sender chose. A partial object is removed before the
   * rejection: a truncated blob under a live key is worse than no blob.
   */
  putStream(key: string, source: Readable, maxBytes: number): Promise<StoredMediaBytes>;

  /**
   * Opens the object for reading. Rejects with `MediaObjectMissingError` when
   * the key holds nothing, which is a real state — an object store and a
   * database can disagree after a restore.
   */
  getStream(key: string): Promise<Readable>;

  /** Removes the object. A key that holds nothing is a success, not an error. */
  delete(key: string): Promise<void>;
}

/** What a write actually put on disk, measured rather than declared. */
export interface StoredMediaBytes {
  readonly sizeBytes: number;
  /** Lower-case hex SHA-256 of the bytes as written. */
  readonly checksumSha256: string;
}

/** Inject with `@Inject(MEDIA_STORAGE) private readonly storage: MediaStorage`. */
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

/**
 * The shape a key must have, enforced by every adapter.
 *
 * Lower-case hex, digits, hyphens and single slashes — which is everything
 * `mediaObjectKey` emits and nothing else. No dots at all, so `..` is
 * unrepresentable rather than filtered for; no leading or trailing slash, so a
 * key cannot become absolute; no empty segment, so `a//b` cannot collapse to a
 * different path on one adapter and not another.
 */
export const MEDIA_STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+$/;
