import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { PlatformAdminGuard } from '../tenancy/admin/platform-admin.guard';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WhatsAppAccessTokenCipher } from './access-token.cipher';
import { AdminWhatsAppController } from './admin/admin-whatsapp.controller';
import { WhatsAppBusinessAccountConnectionService } from './business-account-connection.service';
import { WhatsAppBusinessAccountsController } from './business-accounts.controller';
import { WhatsAppEmbeddedSignupService } from './embedded-signup.service';
import { MessageTemplateQueryService } from './message-template-query.service';
import { MessageTemplateSyncService } from './message-template-sync.service';
import { MessageTemplatesController } from './message-templates.controller';
import { MetaCloudApiClient } from './meta-cloud-api.client';
import { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';
import { WhatsAppMediaService } from './whatsapp-media.service';
import { WhatsAppSenderService } from './whatsapp-sender.service';

/**
 * The WhatsApp channel: business accounts, phone numbers, templates and the Meta
 * Cloud API client (TAR-39, module map — `WhatsAppModule`, access layer).
 *
 * ## What it exports, and to whom
 *
 * `WhatsAppSenderService` is the send path. TAR-20c's inbox calls it to deliver
 * an agent's reply. `WhatsAppMediaService` is the same arrangement for bytes:
 * TAR-20e's media pipeline downloads inbound media and uploads outbound media
 * through it, which is how that module reuses this one's access-token plumbing
 * without becoming a second place a token is decrypted.
 * `MessageTemplateSyncService` is exported so a
 * scheduled refresh can drive it once TAR-41 lands `QueueModule` — templates are
 * a cache of Meta's approval decisions, and today they are only as current as
 * the last sync somebody asked for.
 *
 * `MessageTemplateQueryService` is exported for the send path (TAR-68), which
 * has to prove a named template is approved on the conversation's number
 * *before* it calls Meta — otherwise the refusal comes back as an opaque
 * provider error, after the message row exists. It is a read of this module's
 * own table through this module's own rules, which is exactly what an export is
 * for; the alternative was the inbox querying `message_templates` directly and
 * re-implementing the approved-only filter.
 *
 * `WhatsAppAccessTokenCipher` and `WhatsAppCredentialResolver` stay **private**.
 * They are the only two places a Meta access token is encrypted or decrypted,
 * and the value of that property is entirely in nobody else being able to.
 *
 * ## Layering
 *
 * It imports `TenancyModule` — one layer below it — for
 * `AdminTenantScopeService`, which is what puts the platform-admin routes into a
 * tenant's context. Nothing here imports a domain module: a conversation knows
 * about its WhatsApp number, never the reverse.
 *
 * `PlatformAdminGuard` is declared here rather than imported. It is a stateless
 * guard, so a second instance costs nothing, and declaring it keeps the
 * authentication decision visible in this module's own provider list. It guards
 * `AdminWhatsAppController` only: `WhatsAppBusinessAccountsController` is the
 * tenant-facing Embedded Signup route (TAR-168) and stands on the globally
 * installed pipeline, with no second authentication scheme of its own.
 *
 * `TenantPrisma`, `SystemPrisma` and `TenantContextService` are not listed: all
 * three come from global modules.
 */
@Module({
  imports: [TenancyModule],
  controllers: [
    AdminWhatsAppController,
    WhatsAppBusinessAccountsController,
    MessageTemplatesController,
  ],
  providers: [
    WhatsAppAccessTokenCipher,
    WhatsAppCredentialResolver,
    MetaCloudApiClient,
    WhatsAppBusinessAccountConnectionService,
    WhatsAppEmbeddedSignupService,
    MessageTemplateSyncService,
    MessageTemplateQueryService,
    WhatsAppSenderService,
    WhatsAppMediaService,
    PlatformAdminGuard,
    ApiExceptionFilter,
  ],
  exports: [
    WhatsAppSenderService,
    WhatsAppMediaService,
    MessageTemplateSyncService,
    MessageTemplateQueryService,
  ],
})
export class WhatsAppModule {}
