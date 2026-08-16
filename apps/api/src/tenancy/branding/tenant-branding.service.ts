import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BRANDING_ASSET_LIMITS,
  BRANDING_DEFAULTS,
  brandingAssetPath,
  withBrandingDefaults,
  type BrandingAsset,
  type BrandingAssetKind,
  type BrandingUpdateInput,
  type TenantBranding,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { MEDIA_STORAGE, type MediaStorage } from '../../media/storage/media-storage.port';
import { TENANT_PRISMA, type TenantPrisma } from '../../prisma/prisma.tokens';
import {
  BrandingAssetNotFoundError,
  BrandingAssetTooLargeError,
  BrandingAssetTypeUnsupportedError,
  BrandingAssetUnreadableError,
} from '../tenancy.errors';
import { BRANDING_SNIFF_BYTES, sniffBrandingImageType } from './branding-image-type';
import { brandingObjectKey } from './branding-object-key';

/**
 * Exactly what a branding read needs off the row, and nothing wider — the table
 * has no other columns worth fetching, but the projection is written out so
 * adding one later is a decision rather than an accident.
 */
const BRANDING_PROJECTION = {
  productName: true,
  primaryColor: true,
  accentColor: true,
  supportEmail: true,
  logoStorageKey: true,
  logoMimeType: true,
  logoSizeBytes: true,
  logoUpdatedAt: true,
  faviconStorageKey: true,
  faviconMimeType: true,
  faviconSizeBytes: true,
  faviconUpdatedAt: true,
} as const;

interface BrandingRow {
  readonly productName: string | null;
  readonly primaryColor: string | null;
  readonly accentColor: string | null;
  readonly supportEmail: string | null;
  readonly logoStorageKey: string | null;
  readonly logoMimeType: string | null;
  readonly logoSizeBytes: number | null;
  readonly logoUpdatedAt: Date | null;
  readonly faviconStorageKey: string | null;
  readonly faviconMimeType: string | null;
  readonly faviconSizeBytes: number | null;
  readonly faviconUpdatedAt: Date | null;
}

/** One asset's four columns, read back as a group. */
interface StoredAsset {
  readonly key: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly updatedAt: Date;
}

/** The bytes, plus what to serve them as. */
export interface BrandingAssetContent extends Omit<StoredAsset, 'key'> {
  readonly body: Readable;
}

/**
 * A tenant's white-label appearance: the colours, the product name, and the two
 * image assets (TAR-29).
 *
 * ## The row is created lazily
 *
 * `TenantProvisioningService` writes no `tenant_branding` row, on purpose — a
 * tenant that has configured nothing genuinely has nothing there, and
 * `BRANDING_DEFAULTS` is what makes the response fully populated anyway. So
 * every write here is an `upsert` and every read tolerates a missing row.
 *
 * ## Order of operations on an upload, and why it is this one
 *
 * Validate, write bytes under a **new** key, update the four columns, then
 * delete the previous key best-effort. Not the other way round:
 *
 *   * a row updated before the bytes land points at a logo that does not exist,
 *     and every agent in the tenant sees a broken image until somebody notices;
 *   * bytes written before the row are a stray object that costs disk and
 *     nothing else.
 *
 * One of those is customer-visible and the other is housekeeping, so the order
 * only ever produces the second — the same reasoning `media-object-key.ts`
 * records, and the reason a key carries its own id rather than the asset kind.
 *
 * ## Isolation
 *
 * Everything goes through `TenantPrisma`, so `tenant_isolation` supplies and
 * enforces `tenant_id`, and the storage key is built from the tenant in scope
 * rather than from anything in the request. There is no code path from a request
 * field to a storage location, and the serve route takes no identifier at all.
 */
@Injectable()
export class TenantBrandingService {
  private readonly logger = new Logger(TenantBrandingService.name);

  /** What a tenant that has set no product name is called in this deployment. */
  private readonly platformProductName: string;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    private readonly tenantContext: TenantContextService,
    config: ConfigService,
  ) {
    this.platformProductName =
      config.get<string>('PLATFORM_PRODUCT_NAME') ?? BRANDING_DEFAULTS.productName;
  }

  /** The tenant's branding, fully populated — defaults fill whatever is unset. */
  async read(): Promise<TenantBranding> {
    return this.toBranding(await this.row());
  }

  /**
   * Writes the colours, the product name and the support address.
   *
   * Only the keys the caller sent: `PATCH` semantics, so a form that shows one
   * colour cannot blank the other by omitting it. Clearing the support address
   * is sending `supportEmail: null` explicitly, which is why that one field is
   * nullable rather than merely optional.
   */
  async update(input: BrandingUpdateInput): Promise<TenantBranding> {
    const tenantId = this.tenantContext.requireTenantId();

    const row = await this.prisma.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, ...input },
      update: input,
      select: BRANDING_PROJECTION,
    });

    return this.toBranding(row);
  }

  /**
   * Replaces one asset.
   *
   * `bytes` is the whole file, in memory, and that is safe here in a way it
   * would not be in the media pipeline: the ceiling is 512 KB rather than
   * 100 MB, multer refuses anything larger before this runs, and buffering
   * removes a temporary file on disk that every failure path would otherwise
   * have to remember to clean up.
   *
   * The type is **sniffed**, never taken from the part's declared
   * `Content-Type`, and the sniffed value is what the serve route later sets as
   * the response's own — so a document uploaded as `image/png` is refused, and
   * could not have been served as anything executable even if it were not.
   */
  async replaceAsset(kind: BrandingAssetKind, bytes: Buffer): Promise<TenantBranding> {
    const tenantId = this.tenantContext.requireTenantId();
    const limits = BRANDING_ASSET_LIMITS[kind];

    // Checked here as well as at multer's own limit, which refuses an oversized
    // body mid-stream: this is the check that also covers a caller reaching the
    // service by some other path.
    if (bytes.byteLength > limits.maxBytes) {
      throw new BrandingAssetTooLargeError(kind, limits.maxBytes);
    }

    const mimeType = sniffBrandingImageType(bytes.subarray(0, BRANDING_SNIFF_BYTES));

    if (mimeType === null || !limits.mimeTypes.includes(mimeType)) {
      throw new BrandingAssetTypeUnsupportedError(kind, limits.mimeTypes);
    }

    const previous = storedAsset(await this.row(), kind);
    const key = brandingObjectKey(tenantId, randomUUID());

    await this.storage.putStream(key, Readable.from(bytes), limits.maxBytes);

    const assigned = assetColumns(kind, {
      key,
      mimeType,
      sizeBytes: bytes.byteLength,
      updatedAt: new Date(),
    });

    const row = await this.prisma.tenantBranding
      .upsert({
        where: { tenantId },
        create: { tenantId, ...assigned },
        update: assigned,
        select: BRANDING_PROJECTION,
      })
      .catch(async (error: unknown) => {
        // The bytes are now unreferenced. Removed here rather than left behind,
        // because we know exactly which key it is and we know it is dead.
        await this.discard(key);

        throw error;
      });

    if (previous !== null) {
      await this.discard(previous.key);
    }

    return this.toBranding(row);
  }

  /**
   * Removes one asset: the four columns first, then the bytes.
   *
   * The mirror image of the upload's order, and safe for the same reason — once
   * the row no longer names the key nothing can ask for it, so a failed delete
   * leaves a stray rather than a broken image.
   *
   * A tenant with no such asset is a success, not a 404: `DELETE` is idempotent.
   */
  async removeAsset(kind: BrandingAssetKind): Promise<void> {
    const previous = storedAsset(await this.row(), kind);

    if (previous === null) {
      return;
    }

    // `updateMany` rather than `update`: the row is identified by the tenant in
    // scope, which RLS supplies, so there is no id to pass and no chance of
    // naming another tenant's row.
    await this.prisma.tenantBranding.updateMany({ data: assetColumns(kind, null) });

    await this.discard(previous.key);
  }

  /**
   * The bytes of one asset, for the public serve route.
   *
   * That route takes **no identifier** — the tenant comes from the host and the
   * key is read off that tenant's own row under RLS — so there is nothing to
   * guess and no object reference to authorise.
   */
  async readAsset(kind: BrandingAssetKind): Promise<BrandingAssetContent> {
    const stored = storedAsset(await this.row(), kind);

    if (stored === null) {
      throw new BrandingAssetNotFoundError(kind);
    }

    const body = await this.storage.getStream(stored.key).catch((error: unknown) => {
      // The row is there and the bytes are not: a restore that brought back the
      // database without the volume, or a manual deletion. Logged with the key;
      // the caller is told only that it is a server fault.
      this.logger.error(`Branding ${kind} bytes are missing at ${stored.key}: ${describe(error)}`);

      throw new BrandingAssetUnreadableError(kind);
    });

    return {
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      updatedAt: stored.updatedAt,
      body,
    };
  }

  /**
   * The tenant's row, or null. `findFirst` with no `where`: RLS narrows it to
   * the tenant in scope, and `tenant_branding.tenant_id` is unique, so there is
   * exactly one candidate.
   */
  private async row(): Promise<BrandingRow | null> {
    return await this.prisma.tenantBranding.findFirst({ select: BRANDING_PROJECTION });
  }

  /**
   * Best-effort byte removal. Never thrown from: a leftover blob costs disk, and
   * replacing a successful write — or the validation error a caller needs — with
   * a storage complaint would hide the thing that matters.
   */
  private async discard(key: string): Promise<void> {
    await this.storage.delete(key).catch((error: unknown) => {
      this.logger.warn(`Could not remove branding bytes at ${key}: ${describe(error)}`);
    });
  }

  /**
   * Row → the published shape, with `BRANDING_DEFAULTS` filling everything the
   * tenant has not set.
   *
   * The defaults live here rather than in the database because a
   * `NOT NULL DEFAULT` would bake the platform's own brand into every row and
   * make "has this tenant customised anything" unanswerable.
   */
  private toBranding(row: BrandingRow | null): TenantBranding {
    // `withBrandingDefaults` is the console's fill too (TAR-418), so the login
    // screen and this response cannot disagree about what an unconfigured tenant
    // looks like. Only the product name is deployment-specific, and it is
    // resolved before the helper sees it.
    return withBrandingDefaults({
      productName: row?.productName ?? this.platformProductName,
      primaryColor: row?.primaryColor ?? undefined,
      accentColor: row?.accentColor ?? undefined,
      supportEmail: row?.supportEmail ?? null,
      logo: toAsset(storedAsset(row, 'logo'), 'logo'),
      favicon: toAsset(storedAsset(row, 'favicon'), 'favicon'),
    });
  }
}

/**
 * The four columns of one asset, written as one group.
 *
 * `tenant_branding_logo_complete` and its favicon twin are CHECK constraints
 * requiring all four to be null or all four set, so a statement that names three
 * of them is a rejected write. Spelled out per kind rather than built from a
 * column-name map: a computed key is untyped, and the types are the thing that
 * makes "all four, every time" mechanical rather than remembered.
 */
function assetColumns(kind: BrandingAssetKind, asset: StoredAsset | null) {
  if (kind === 'logo') {
    return {
      logoStorageKey: asset?.key ?? null,
      logoMimeType: asset?.mimeType ?? null,
      logoSizeBytes: asset?.sizeBytes ?? null,
      logoUpdatedAt: asset?.updatedAt ?? null,
    };
  }

  return {
    faviconStorageKey: asset?.key ?? null,
    faviconMimeType: asset?.mimeType ?? null,
    faviconSizeBytes: asset?.sizeBytes ?? null,
    faviconUpdatedAt: asset?.updatedAt ?? null,
  };
}

/**
 * The stored asset of one kind, or null when the group is empty.
 *
 * The CHECK constraints guarantee the four columns move together, so the key
 * being present implies the rest — but the check is written out anyway, because
 * the generated types are nullable and a non-null assertion here would rest on a
 * constraint Prisma cannot see.
 */
function storedAsset(row: BrandingRow | null, kind: BrandingAssetKind): StoredAsset | null {
  if (row === null) {
    return null;
  }

  const [key, mimeType, sizeBytes, updatedAt] =
    kind === 'logo'
      ? ([row.logoStorageKey, row.logoMimeType, row.logoSizeBytes, row.logoUpdatedAt] as const)
      : ([
          row.faviconStorageKey,
          row.faviconMimeType,
          row.faviconSizeBytes,
          row.faviconUpdatedAt,
        ] as const);

  if (key === null || mimeType === null || sizeBytes === null || updatedAt === null) {
    return null;
  }

  return { key, mimeType, sizeBytes, updatedAt };
}

function toAsset(stored: StoredAsset | null, kind: BrandingAssetKind): BrandingAsset | null {
  if (stored === null) {
    return null;
  }

  return {
    // Relative and cache-busted. Never an absolute URL: the same row is served
    // under a platform subdomain and under a custom domain, and a stored origin
    // would make the browser fetch cross-origin under the other one.
    path: brandingAssetPath(kind, stored.updatedAt),
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    updatedAt: stored.updatedAt.toISOString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
