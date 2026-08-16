import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  Query,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  BRANDING_ASSET_LIMITS,
  BRANDING_UPLOAD_FIELD,
  BrandingAssetKindSchema,
  TENANT_HOST_HEADER,
  TenantUpdateInputSchema,
  type BrandingAssetKind,
  type TenantBranding,
  type TenantPublicResponse,
  type TenantResponse,
  type TenantUpdateInput,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { Public } from '../common/request-pipeline/route-access';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AnyPrincipal, RequirePermission } from '../rbac/require-permission.decorator';
import { TenantBrandingService } from './branding/tenant-branding.service';
import { TenantDomainsService } from './domains/tenant-domains.service';
import { TenantProfileService } from './tenant-profile.service';
import { BrandingFileMissingError } from './tenancy.errors';
import { translateTenancyFailure } from './tenancy.http';

/** The largest branding upload any kind allows, as multer's transport cap. */
const BRANDING_MAX_BYTES = Math.max(
  ...Object.values(BRANDING_ASSET_LIMITS).map((limit) => limit.maxBytes),
);

/**
 * Multer's file object, narrowed to what this controller reads.
 *
 * Declared rather than imported, for the reason `media.controller.ts` gives:
 * `@nestjs/platform-express` bundles multer but publishes no `File` type, and
 * `@types/multer` would be a dependency added to name two properties.
 */
interface MulterFile {
  buffer: Buffer;
  size: number;
}

/**
 * Multer options for a branding part.
 *
 * **Memory storage, deliberately** — the default when no `dest` is given. The
 * media pipeline streams to a temporary file because a document may be 100 MB;
 * a logo is capped at 512 KB, so buffering costs nothing and removes a file on
 * disk that every failure path would otherwise have to remember to clean up.
 *
 * The limits are the transport cap. The per-kind ceiling is enforced in
 * `TenantBrandingService` once the kind is known, and it is the one a caller
 * sees quoted — a single cap could not do both without letting a 512 KB favicon
 * through.
 */
const BRANDING_UPLOAD_OPTIONS = {
  limits: {
    fileSize: BRANDING_MAX_BYTES,
    // One file and nothing else. A multipart body with twenty parts is a
    // denial-of-service shape rather than a logo.
    files: 1,
    fields: 2,
    parts: 4,
  },
} as const;

/**
 * The tenant's own record: identity, branding, and the hostnames it answers on
 * (TAR-29, implementing TAR-416's endpoint surface).
 *
 * ## Which routes are open, and what "open" means here
 *
 * `GET /tenant/public` and the two asset routes are `@Public()`, which gives up
 * the *session* and not the tenant: `HostTenantGuard` still runs, so the tenant
 * is resolved from the host and from nothing else. That is the whole design of
 * pre-login theming — the login screen has to be branded before anybody has a
 * session, and there is no tenant field anywhere in these contracts for a caller
 * to choose.
 *
 * None of the three takes a parameter that names a tenant, a row or a storage
 * key. `GET /tenant/public` takes nothing at all: a tenant identifier on it
 * would hand an anonymous caller an enumeration oracle, and the asset routes
 * take only the kind, which is one of two literals.
 *
 * ## Caching
 *
 * ⚠️ Every route here is the **same path for every tenant** — the tenant is the
 * host. Any cache in front of them, at the edge or in the web tier's `fetch`,
 * must key on the host. A cache keyed on the URL alone is a direct cross-tenant
 * leak, and it is the highest-severity mistake available in this feature.
 *
 * The two `@Public()` routes therefore say so on the wire: `Vary` names
 * `TENANT_HOST_HEADER`, because on the hop that actually matters — the Next
 * rewrite in `apps/web/next.config.mjs`, where every tenant reaches one
 * `API_BASE_URL` — the host travels in that header and nowhere in the URL. The
 * asset route pairs a one-year `public, immutable` lifetime with it; without the
 * `Vary` those two lines together are the leak the paragraph above describes.
 */
@Controller({ path: 'tenant', version: '1' })
@UseFilters(ApiExceptionFilter)
export class TenantController {
  constructor(
    private readonly profile: TenantProfileService,
    private readonly branding: TenantBrandingService,
    private readonly domains: TenantDomainsService,
  ) {}

  /**
   * `GET /api/v1/tenant/public` — branding for a caller with no session.
   *
   * The minimum an anonymous caller may see: the tenant's display name and its
   * appearance. No slug, no status, no domain list, no counts — anything more
   * would be published to the internet for every white-label host.
   */
  @Get('public')
  @Public()
  async public(@Res({ passthrough: true }) response: Response): Promise<TenantPublicResponse> {
    response.setHeader('vary', TENANT_HOST_HEADER);

    return await this.profile
      .readPublic()
      .catch((error: unknown) => translateTenancyFailure(error));
  }

  /**
   * The bytes of the tenant's logo or favicon, for the same anonymous caller.
   *
   * The route takes no identifier — the tenant comes from the host and the
   * storage key is read off that tenant's own row under RLS — so there is
   * nothing to guess and no object reference to authorise.
   *
   * The headers are the security half. `Content-Type` is the **sniffed** type
   * from the column, never the one the uploader declared; `nosniff` and a
   * `default-src 'none'` policy stop a browser deciding the bytes are something
   * executable on this origin; and `Content-Disposition: inline` is safe only
   * because of the two before it.
   *
   * `?v=` is `logo_updated_at`. A request carrying the current one is answered
   * `immutable` for a year, because a new upload is a new URL; anything else
   * gets a minute, so a stale link corrects itself quickly.
   */
  @Get('branding/:kind')
  @Public()
  async asset(
    @Param('kind', new ZodValidationPipe(BrandingAssetKindSchema)) kind: BrandingAssetKind,
    @Query('v') version: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const asset = await this.branding
      .readAsset(kind)
      .catch((error: unknown) => translateTenancyFailure(error));

    const current = String(asset.updatedAt.getTime());

    response.setHeader('content-type', asset.mimeType);
    response.setHeader('content-length', asset.sizeBytes);
    response.setHeader('content-disposition', 'inline');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'none'");
    response.setHeader('etag', `"${kind}-${current}"`);
    // The tenant is not in the URL, so it has to be in `Vary` — see the class
    // comment. `public, immutable` without this is one shared cache away from
    // serving one tenant's logo under another tenant's brand.
    response.setHeader('vary', TENANT_HOST_HEADER);
    response.setHeader(
      'cache-control',
      version === current ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    );

    await pipeline(asset.body, response);
  }

  /**
   * `GET /api/v1/tenant` — the workspace as its own members see it.
   *
   * `@AnyPrincipal()`: every signed-in user needs the product name and the
   * colours to render the shell, so gating this behind `tenant:settings` would
   * refuse the whole call to an agent who may read the workspace name.
   *
   * The domain list it carries is narrowed to match — see
   * `TenantDomainsService.listForCaller()`. An open route composing the full
   * rows would hand every member the pending challenge tokens that
   * `GET /tenant/domains` refuses them one path over.
   */
  @Get()
  @AnyPrincipal()
  async read(): Promise<TenantResponse> {
    return await this.tenantResponse();
  }

  /**
   * `PATCH /api/v1/tenant` — rename the workspace, or change its appearance.
   *
   * `branding:write`, and the body cannot carry bytes: the logo and the favicon
   * are set by the two routes below, because a multipart body and a JSON patch
   * are different request shapes and folding them together makes both worse.
   */
  @Patch()
  @RequirePermission('branding:write')
  async update(
    @Body(new ZodValidationPipe(TenantUpdateInputSchema)) input: TenantUpdateInput,
  ): Promise<TenantResponse> {
    await this.profile.update(input).catch((error: unknown) => translateTenancyFailure(error));

    if (input.branding !== undefined) {
      await this.branding
        .update(input.branding)
        .catch((error: unknown) => translateTenancyFailure(error));
    }

    return await this.tenantResponse();
  }

  /**
   * `PUT`, not `POST`: there is exactly one logo per tenant and replacing it is
   * idempotent — the same file uploaded twice leaves the same state, which a
   * `POST` to a collection would not.
   *
   * The `try` opens before the first refusal because multer has already read the
   * part by the time this runs. The pipeline guards refuse an unauthenticated or
   * unpermitted caller before multer runs at all, so nothing is buffered for
   * somebody who may not upload.
   */
  @Put('branding/:kind')
  @RequirePermission('branding:write')
  @UseInterceptors(FileInterceptor(BRANDING_UPLOAD_FIELD, BRANDING_UPLOAD_OPTIONS))
  async replaceAsset(
    @Param('kind', new ZodValidationPipe(BrandingAssetKindSchema)) kind: BrandingAssetKind,
    @UploadedFile() file: MulterFile | undefined,
  ): Promise<TenantBranding> {
    if (file === undefined) {
      translateTenancyFailure(new BrandingFileMissingError(BRANDING_UPLOAD_FIELD));
    }

    return await this.branding
      .replaceAsset(kind, file.buffer)
      .catch((error: unknown) => translateTenancyFailure(error));
  }

  @Delete('branding/:kind')
  @RequirePermission('branding:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAsset(
    @Param('kind', new ZodValidationPipe(BrandingAssetKindSchema)) kind: BrandingAssetKind,
  ): Promise<void> {
    await this.branding.removeAsset(kind).catch((error: unknown) => translateTenancyFailure(error));
  }

  /**
   * The three reads a `TenantResponse` needs, issued together.
   *
   * Concurrent because they are independent queries on one connection pool and
   * the response cannot be assembled without all three; sequential would be
   * three round trips of latency for nothing.
   *
   * `listForCaller()` rather than `list()`, on both routes that use this: the
   * `PATCH` is `branding:write`, which an admin holds and a supervisor does not,
   * so it is the same question and it gets the same answer.
   */
  private async tenantResponse(): Promise<TenantResponse> {
    const [profile, branding, domains] = await Promise.all([
      this.profile.read(),
      this.branding.read(),
      this.domains.listForCaller(),
    ]).catch((error: unknown) => translateTenancyFailure(error));

    return { ...profile, branding, domains };
  }
}
