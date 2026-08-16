import { MEDIA_STORAGE_KEY_PATTERN } from '../../media/storage/media-storage.port';
import { brandingObjectKey } from './branding-object-key';

const TENANT_A = '0192f000-0000-7000-8000-00000000a001';
const TENANT_B = '0192f000-0000-7000-8000-00000000a002';
const STORAGE_ID = '0192f0aa-0000-7000-8000-00000000b001';

describe('brandingObjectKey', () => {
  it('puts the tenant first, so one tenant’s objects are one prefix', () => {
    // What makes a per-tenant hard delete a prefix operation rather than a scan,
    // and what makes a stray object in a listing self-identifying.
    expect(brandingObjectKey(TENANT_A, STORAGE_ID)).toBe(
      `tenants/${TENANT_A}/branding/${STORAGE_ID}`,
    );
  });

  it('never puts two tenants under one prefix', () => {
    expect(brandingObjectKey(TENANT_A, STORAGE_ID)).not.toBe(
      brandingObjectKey(TENANT_B, STORAGE_ID),
    );
  });

  it('emits a key every storage adapter will accept', () => {
    // The adapters validate independently — a filesystem adapter that trusted
    // its caller is one refactor away from a path traversal.
    expect(MEDIA_STORAGE_KEY_PATTERN.test(brandingObjectKey(TENANT_A, STORAGE_ID))).toBe(true);
  });

  it('lower-cases, so one tenant cannot hold two prefixes', () => {
    expect(brandingObjectKey(TENANT_A.toUpperCase(), STORAGE_ID.toUpperCase())).toBe(
      `tenants/${TENANT_A}/branding/${STORAGE_ID}`,
    );
  });

  it.each([
    ['a traversal segment', '..'],
    ['an empty id', ''],
    ['a dot', 'logo.png'],
    ['a backslash', 'a\\b'],
    ['a leading slash', '/etc/passwd'],
  ])('throws rather than building a path from %s', (_label, storageId) => {
    // Unreachable with a UUID, which is the point: a caller that ever passes
    // something else fails here rather than becoming a path on disk. The shared
    // pattern forbids dots outright, so `..` is unrepresentable rather than
    // filtered for.
    expect(() => brandingObjectKey(TENANT_A, storageId)).toThrow(/expected shape/);
  });
});
