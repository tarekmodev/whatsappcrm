import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { MissingTenantContextError } from '../prisma/prisma.errors';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { MediaNotFoundError } from './media.errors';
import { MediaReaderService } from './media-reader.service';
import { MediaUploadService } from './media-upload.service';
import { FilesystemMediaStorage } from './storage/filesystem-media.storage';

/**
 * TAR-20e's fourth acceptance criterion — "stored media is tenant-scoped and not
 * retrievable cross-tenant" — against a real PostgreSQL with TAR-48's policies
 * applied and a real object store on disk.
 *
 * A unit test can show that the reader passes an id to `findUnique`. Only this
 * can show that `media_objects` actually carries the `tenant_isolation` policy,
 * that the app role's grants reach it, and that the storage key a request can
 * never name is the only way to the bytes. Everything below runs as
 * `whatsappcrm_app`, the role holding no `BYPASSRLS`.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants with fixed ids and a `tar70-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one. Point
 * `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '70444444-4444-7444-8444-444444444401';
const TENANT_B = '70444444-4444-7444-8444-444444444402';

const REQUEST_ID = 'tar70-int-spec';
const FIXTURE_PREFIX = 'tar70-fixture';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('tenant A only'),
]);

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

describe('media is tenant-scoped, end to end', () => {
  const tenantContext = new TenantContextService();

  let root: string;
  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let storage: FilesystemMediaStorage;
  let reader: MediaReaderService;
  let uploads: MediaUploadService;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    // `media_objects` cascades from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  /** Writes one media object for `tenantId` and returns its id and storage key. */
  async function seedMedia(tenantId: string, marker: string): Promise<{ id: string; key: string }> {
    return await asTenant(tenantId, async () => {
      const key = `tenants/${tenantId}/image/${marker}`;

      await storage.putStream(key, Readable.from(PNG), 1_024);

      const created = await tenantPrisma.mediaObject.create({
        data: {
          tenantId,
          kind: 'image',
          source: 'upload',
          storageKey: key,
          mimeType: 'image/png',
          sizeBytes: PNG.length,
          checksumSha256: 'a'.repeat(64),
          fileName: `${marker}.png`,
        },
        select: { id: true },
      });

      return { id: created.id, key };
    });
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tar70-int-'));
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    storage = new FilesystemMediaStorage({ getOrThrow: () => root } as unknown as ConfigService);
    reader = new MediaReaderService(tenantPrisma, storage);
    uploads = new MediaUploadService(tenantPrisma, storage, tenantContext);

    await removeFixture();
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-70 tenant A', status: 'active' },
        { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-70 tenant B', status: 'active' },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await rm(root, { recursive: true, force: true });
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  it('refuses a media read with no tenant in scope', async () => {
    await tenantContext.run({ requestId: REQUEST_ID, tenantId: null, userId: null }, async () => {
      await expect(reader.describe(TENANT_A)).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

  it('does not let one tenant describe another tenant’s media', async () => {
    const mine = await seedMedia(TENANT_A, 'aaaa1111-2222-3333');

    await expect(asTenant(TENANT_A, async () => reader.describe(mine.id))).resolves.toMatchObject({
      fileName: 'aaaa1111-2222-3333.png',
    });

    // Absent, not forbidden: a 403 would confirm the id exists (TAR-39).
    await expect(asTenant(TENANT_B, async () => reader.describe(mine.id))).rejects.toBeInstanceOf(
      MediaNotFoundError,
    );
  });

  it('does not let one tenant read another tenant’s bytes', async () => {
    const mine = await seedMedia(TENANT_A, 'bbbb1111-2222-3333');

    await expect(
      asTenant(TENANT_A, async () => collect((await reader.read(mine.id)).body)),
    ).resolves.toEqual(PNG);

    await expect(asTenant(TENANT_B, async () => reader.read(mine.id))).rejects.toBeInstanceOf(
      MediaNotFoundError,
    );
  });

  it('keeps one tenant’s media out of the other’s listing', async () => {
    await seedMedia(TENANT_A, 'cccc1111-2222-3333');
    await seedMedia(TENANT_B, 'dddd1111-2222-3333');

    const forA = await asTenant(TENANT_A, async () =>
      tenantPrisma.mediaObject.findMany({ select: { fileName: true } }),
    );
    const forB = await asTenant(TENANT_B, async () =>
      tenantPrisma.mediaObject.findMany({ select: { fileName: true } }),
    );

    expect(forA.map((row) => row.fileName)).toContain('cccc1111-2222-3333.png');
    expect(forA.map((row) => row.fileName)).not.toContain('dddd1111-2222-3333.png');
    expect(forB.map((row) => row.fileName)).toEqual(['dddd1111-2222-3333.png']);
  });

  it('writes an uploaded object under its own tenant’s prefix', async () => {
    const { path, cleanup } = await temporaryUpload();

    try {
      const stored = await asTenant(TENANT_B, async () =>
        uploads.store({
          path,
          originalName: 'photo.png',
          declaredMimeType: 'image/png',
          sizeBytes: PNG.length,
        }),
      );

      const row = await asTenant(TENANT_B, async () =>
        tenantPrisma.mediaObject.findUniqueOrThrow({
          where: { id: stored.id },
          select: { tenantId: true, storageKey: true, sizeBytes: true },
        }),
      );

      expect(row.tenantId).toBe(TENANT_B);
      expect(row.storageKey.startsWith(`tenants/${TENANT_B}/`)).toBe(true);
      expect(row.sizeBytes).toBe(PNG.length);
    } finally {
      await cleanup();
    }
  });

  it('refuses a write that names another tenant, at the database', async () => {
    // Belt and braces: the service always writes the tenant in scope, and the
    // `WITH CHECK` half of the policy is what makes that unbypassable.
    await expect(
      asTenant(TENANT_A, async () =>
        tenantPrisma.mediaObject.create({
          data: {
            tenantId: TENANT_B,
            kind: 'image',
            source: 'upload',
            storageKey: `tenants/${TENANT_B}/image/eeee1111-2222-3333`,
            mimeType: 'image/png',
            sizeBytes: 1,
            checksumSha256: 'b'.repeat(64),
          },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow();
  });

  it('cannot be made to serve another tenant’s bytes by naming its storage key', async () => {
    const theirs = await seedMedia(TENANT_B, 'ffff1111-2222-3333');

    // There is no route from a request to a key — the reader takes an id and
    // reads the key off the row it resolved — so the only way to ask for
    // another tenant's object is by id, and that is already `not found`.
    await expect(asTenant(TENANT_A, async () => reader.read(theirs.id))).rejects.toBeInstanceOf(
      MediaNotFoundError,
    );

    // The bytes are genuinely there for their owner, so the assertion above is
    // about authorisation rather than about an empty store.
    await expect(
      asTenant(TENANT_B, async () => collect((await reader.read(theirs.id)).body)),
    ).resolves.toEqual(PNG);
  });

  /** A part on disk, as multer would have written it. */
  async function temporaryUpload(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const directory = await mkdtemp(join(tmpdir(), 'tar70-part-'));
    const path = join(directory, 'part');

    await writeFile(path, PNG);

    return { path, cleanup: async () => await rm(directory, { recursive: true, force: true }) };
  }
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
