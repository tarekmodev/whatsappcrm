import { MEDIA_STORAGE_KEY_PATTERN } from '../../media/storage/media-storage.port';

/**
 * The one place a branding storage key is built (TAR-39, multi-tenancy rule 6 —
 * "everything shared is namespaced by tenant").
 *
 * ```
 * tenants/<tenantId>/branding/<storageId>
 * ```
 *
 * Deliberately the same tenant-first shape as `mediaObjectKey`, so a per-tenant
 * hard delete stays one prefix operation and a stray object in a listing still
 * names its owner. `branding` sits where `mediaObjectKey` puts the media kind.
 *
 * `storageId` is its own identifier rather than the asset kind, and that is what
 * makes an upload safe to order bytes-then-row: a new upload writes a new key,
 * so the row keeps pointing at the previous logo until the update commits, and
 * an agent never sees a broken image. The old key is removed afterwards,
 * best-effort — a stray blob is a sweep, a row pointing at bytes that were never
 * written is a defect somebody looks at.
 *
 * Neither segment ever comes from a request. There is no code path from an
 * upload to a storage location.
 */
export function brandingObjectKey(tenantId: string, storageId: string): string {
  const key = `tenants/${tenantId.toLowerCase()}/branding/${storageId.toLowerCase()}`;

  if (!MEDIA_STORAGE_KEY_PATTERN.test(key)) {
    // Unreachable with two UUIDs, which is the point: a caller that ever passes
    // something else fails here rather than becoming a path on disk. Neither id
    // is echoed — the key is, and it contains both.
    throw new Error(`Built a branding storage key that is not of the expected shape: ${key}`);
  }

  return key;
}
