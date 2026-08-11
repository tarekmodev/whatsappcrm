import type { MediaKind } from '@whatsappcrm/contracts';
import { MEDIA_STORAGE_KEY_PATTERN } from './storage/media-storage.port';

/**
 * The one place a storage key is built (TAR-39, multi-tenancy rule 6 —
 * "everything shared is namespaced by tenant").
 *
 * ```
 * tenants/<tenantId>/<kind>/<storageId>
 * ```
 *
 * ## `storageId` is its own identifier, not the row id
 *
 * Because the bytes are written **before** the row exists, and that order is
 * the safe one: a blob with no row is a stray the retention sweep collects,
 * while a row pointing at bytes that were never written is a broken attachment
 * an agent sees. Deriving the key from the row id would force the other order,
 * or a placeholder key and a second UPDATE.
 *
 * The cost is that a stray object in a listing does not name its row. The
 * `(tenant_id, storage_key)` unique index answers that in one query, and the
 * tenant — the thing that actually matters during an incident — is in the key
 * either way.
 *
 * ## Why this shape
 *
 * **Tenant first**, so every object one tenant owns is under one prefix. That
 * is what makes a per-tenant delete on hard-delete (TAR-39, tenant lifecycle) a
 * prefix operation rather than a scan, what makes a bucket policy or an IAM
 * condition expressible per tenant when the object-store adapter lands, and
 * what makes a stray object in a listing self-identifying during an incident.
 *
 * **Kind second**, because it costs nothing and answers "how much video is this
 * tenant storing" without a database query.
 *
 * **The row id last, and nothing else.** No file name, ever: a file name is
 * user input, it is not unique, and a key derived from one is a path traversal
 * with extra steps. The name the recipient sees is a column and a
 * `Content-Disposition` header, not a path segment.
 *
 * No extension either. The media type is a column; an extension in the key
 * would be a second, silently divergent copy of it, and the store serves bytes
 * rather than guessing types from paths.
 *
 * ## Not derived from the digest
 *
 * Content-addressing would deduplicate two agents uploading the same PDF, which
 * sounds free and is not: one tenant's delete would then remove another
 * tenant's file, and the shared key would be a cross-tenant channel — upload a
 * candidate file, observe whether the write is a no-op, learn what the
 * neighbour holds. Storage is cheap; that is not.
 */
export function mediaObjectKey(tenantId: string, kind: MediaKind, storageId: string): string {
  const key = `tenants/${tenantId.toLowerCase()}/${kind}/${storageId.toLowerCase()}`;

  if (!MEDIA_STORAGE_KEY_PATTERN.test(key)) {
    // Unreachable with two UUIDs and an enum value, which is the point: if a
    // caller ever passes something else, it fails here rather than becoming a
    // path on disk. Neither id is echoed — the key is, and it contains both.
    throw new Error(`Built a storage key that is not of the expected shape: ${key}`);
  }

  return key;
}
