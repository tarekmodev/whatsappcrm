import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import {
  MediaContentMismatchError,
  MediaTooLargeError,
  UnsupportedMediaTypeError,
} from './media.errors';
import { MediaUploadService, type UploadedMediaFile } from './media-upload.service';

const TENANT = '70444444-4444-7444-8444-444444444401';
const USER = '70444444-4444-7444-8444-4444444444c1';
const CREATED_ID = '70444444-4444-7444-8444-4444444444f1';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a small picture'),
]);

describe('MediaUploadService', () => {
  let directory: string;
  let tenantContext: TenantContextService;
  let create: jest.Mock;
  let putStream: jest.Mock;
  let deleteObject: jest.Mock;
  let service: MediaUploadService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tar70-upload-'));
    tenantContext = new TenantContextService();

    create = jest.fn().mockResolvedValue({ id: CREATED_ID });
    putStream = jest
      .fn()
      .mockImplementation(async (_key: string, source: NodeJS.ReadableStream) => {
        // Drain, as a real adapter would, so a leaked handle shows up here
        // rather than as an open-handle warning at the end of the run.
        const chunks: Buffer[] = [];

        for await (const chunk of source) {
          chunks.push(chunk as Buffer);
        }

        const bytes = Buffer.concat(chunks);

        return {
          sizeBytes: bytes.length,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        };
      });
    deleteObject = jest.fn().mockResolvedValue(undefined);

    service = new MediaUploadService(
      { mediaObject: { create } } as unknown as TenantPrisma,
      { putStream, getStream: jest.fn(), delete: deleteObject },
      tenantContext,
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Writes a part the way multer would, and describes it the way the controller does. */
  async function part(
    bytes: Buffer,
    declaredMimeType: string,
    originalName = 'picture.png',
  ): Promise<UploadedMediaFile> {
    const path = join(directory, `part-${Math.abs(bytes.length)}-${originalName}`);

    await writeFile(path, bytes);

    return { path, originalName, declaredMimeType, sizeBytes: bytes.length };
  }

  function inTenantScope<T>(work: () => Promise<T>, userId: string | null = USER): Promise<T> {
    return tenantContext.run({ requestId: 'tar70', tenantId: TENANT, userId }, work);
  }

  /** The key the storage adapter was asked to write to. */
  function storedKey(): string {
    const [call] = putStream.mock.calls as [string][];

    if (call === undefined) {
      throw new Error('nothing was written to storage');
    }

    return call[0];
  }

  /** The `data` the row insert was built from. */
  function insertedRow(): Record<string, unknown> {
    const [call] = create.mock.calls as [{ data: Record<string, unknown> }][];

    if (call === undefined) {
      throw new Error('no row was inserted');
    }

    return call[0].data;
  }

  it('stores the bytes and records the row', async () => {
    const uploaded = await inTenantScope(async () => service.store(await part(PNG, 'image/png')));

    expect(uploaded).toEqual({ id: CREATED_ID });

    const key = storedKey();

    expect(key).toMatch(new RegExp(`^tenants/${TENANT}/image/`));
    expect(create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        kind: 'image',
        source: 'upload',
        storageKey: key,
        mimeType: 'image/png',
        sizeBytes: PNG.length,
        checksumSha256: createHash('sha256').update(PNG).digest('hex'),
        fileName: 'picture.png',
        uploadedByUserId: USER,
      },
      select: { id: true },
    });
  });

  it('records the measured size and digest, not the ones it was handed', async () => {
    // The part claims to be tiny; the file on disk is not. What is stored has
    // to describe what was stored.
    const lying = { ...(await part(PNG, 'image/png')), sizeBytes: 1 };

    await inTenantScope(async () => service.store(lying));

    expect(insertedRow().sizeBytes).toBe(PNG.length);
  });

  it('refuses a type WhatsApp does not carry, before copying anything', async () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

    await expect(
      inTenantScope(async () => service.store(await part(gif, 'image/gif', 'anim.gif'))),
    ).rejects.toThrow(UnsupportedMediaTypeError);

    expect(putStream).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a file whose bytes contradict its declared type', async () => {
    await expect(
      inTenantScope(async () => service.store(await part(PNG, 'application/pdf', 'invoice.pdf'))),
    ).rejects.toThrow(MediaContentMismatchError);

    expect(putStream).not.toHaveBeenCalled();
  });

  it('applies the ceiling of the resolved kind', async () => {
    // Six megabytes is a legal document and an illegal image. The declared type
    // says image, so the image ceiling applies.
    const oversize = { ...(await part(PNG, 'image/png')), sizeBytes: 6 * 1_024 * 1_024 };

    await expect(inTenantScope(async () => service.store(oversize))).rejects.toThrow(
      MediaTooLargeError,
    );
    expect(putStream).not.toHaveBeenCalled();
  });

  it('removes the stored bytes when the row cannot be written', async () => {
    create.mockRejectedValueOnce(new Error('the database went away'));

    await expect(
      inTenantScope(async () => service.store(await part(PNG, 'image/png'))),
    ).rejects.toThrow(/database went away/);

    expect(deleteObject).toHaveBeenCalledWith(storedKey());
  });

  it('records no uploader for an unauthenticated context', async () => {
    // Reachable once machine-to-machine callers exist; the column is nullable
    // for exactly that, and a missing user must not become a missing row.
    await inTenantScope(async () => service.store(await part(PNG, 'image/png')), null);

    expect(insertedRow().uploadedByUserId).toBeNull();
  });

  it('refuses to store anything with no tenant in scope', async () => {
    await expect(service.store(await part(PNG, 'image/png'))).rejects.toThrow(/No tenant in scope/);
    expect(putStream).not.toHaveBeenCalled();
  });

  it('discards a temporary file, and says so quietly when there is none', async () => {
    const { path } = await part(PNG, 'image/png');

    await service.discardTemporary(path);

    await expect(stat(path)).rejects.toThrow();
    // Called again on a path that is already gone — the controller's `finally`
    // runs on every path, including ones where nothing was written.
    await expect(service.discardTemporary(path)).resolves.toBeUndefined();
  });
});
