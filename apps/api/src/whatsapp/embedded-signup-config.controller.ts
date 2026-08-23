import { Controller, Get, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WhatsAppEmbeddedSignupConfigResponse } from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { RequirePermission } from '../rbac/require-permission.decorator';

/**
 * `GET /api/v1/whatsapp/embedded-signup/config` — what the console needs to
 * launch Embedded Signup, read from the API's runtime configuration (TAR-816).
 *
 * ## Why this exists
 *
 * `apps/web/lib/config/env.ts` reads `NEXT_PUBLIC_META_APP_ID` and
 * `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID`, which Next.js inlines into the
 * browser bundle **at build time**. TAR-816 makes the API's copy of both
 * operator-editable at runtime; without an endpoint the console can read, that
 * is a setting which appears to save and changes nothing, because the browser is
 * still holding what was compiled in at the last deploy. This is the single most
 * likely way this feature ships "working" and is not.
 *
 * The console is not switched over in this change. TAR-814 is rebuilding the
 * WhatsApp connect surface and would collide with an edit to the same call site,
 * so the endpoint lands first and `apps/web` moves off `webEnv.metaAppId` in one
 * place once that work settles — TAR-811's own sequencing note, which either
 * order satisfies and concurrent edits do not.
 *
 * ## Authentication
 *
 * Ordinary tenant pipeline plus `channel:manage`, the same permission as the
 * connect call this feeds. Not because the values need protecting — neither is a
 * secret, and both already reach every browser that opens the connect screen —
 * but because an anonymous endpoint reporting how this platform's Meta app is
 * configured is a free reconnaissance surface for no gain.
 *
 * Nothing on it is tenant-specific: these are the platform's own ids, identical
 * for every tenant, so there is no isolation question to answer and no place in
 * the contract to ask for another tenant's anything.
 */
@Controller({ path: 'whatsapp/embedded-signup', version: '1' })
@UseFilters(ApiExceptionFilter)
export class WhatsAppEmbeddedSignupConfigController {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `null` for either id means unconfigured, and the console must render that as
   * "WhatsApp connection is not available in this environment" rather than
   * calling `FB.login` with `undefined`.
   *
   * `graphApiVersion` is not operator-managed and comes straight from the
   * environment: a wrong value breaks every send at once, and the pin is
   * deliberate. It is served here anyway so the browser SDK and the server agree
   * on one version rather than each carrying its own copy.
   */
  @Get('config')
  @RequirePermission('channel:manage')
  read(): WhatsAppEmbeddedSignupConfigResponse {
    return {
      appId: this.settings.get('meta.app_id'),
      configId: this.settings.get('meta.embedded_signup_config_id'),
      graphApiVersion: this.config.getOrThrow<string>('META_GRAPH_API_VERSION'),
    };
  }
}
