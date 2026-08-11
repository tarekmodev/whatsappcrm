import { MediaKind } from '../generated/prisma/enums';
import { mediaObjectKey } from './media-object-key';
import { MEDIA_STORAGE_KEY_PATTERN } from './storage/media-storage.port';

const TENANT = '70444444-4444-7444-8444-444444444401';
const OBJECT = '70444444-4444-7444-8444-4444444444f1';

describe('mediaObjectKey', () => {
  it('namespaces by tenant, then by kind', () => {
    expect(mediaObjectKey(TENANT, MediaKind.image, OBJECT)).toBe(
      `tenants/${TENANT}/image/${OBJECT}`,
    );
  });

  it('emits a key the storage adapters accept', () => {
    for (const kind of Object.values(MediaKind)) {
      expect(mediaObjectKey(TENANT, kind, OBJECT)).toMatch(MEDIA_STORAGE_KEY_PATTERN);
    }
  });

  it('lower-cases both ids, so one object cannot have two keys', () => {
    expect(mediaObjectKey(TENANT.toUpperCase(), MediaKind.document, OBJECT.toUpperCase())).toBe(
      `tenants/${TENANT}/document/${OBJECT}`,
    );
  });

  it('refuses to build a key from anything that is not an id', () => {
    // Unreachable through the pipeline — both arguments are UUIDs there — and
    // the point is that it stays unreachable if a caller ever changes.
    expect(() => mediaObjectKey('../other-tenant', MediaKind.image, OBJECT)).toThrow(
      /not of the expected shape/,
    );
    expect(() => mediaObjectKey(TENANT, MediaKind.image, '../../etc/passwd')).toThrow(
      /not of the expected shape/,
    );
  });

  it('produces different keys for different tenants holding the same object id', () => {
    const other = '70444444-4444-7444-8444-444444444402';

    expect(mediaObjectKey(TENANT, MediaKind.image, OBJECT)).not.toBe(
      mediaObjectKey(other, MediaKind.image, OBJECT),
    );
  });
});
