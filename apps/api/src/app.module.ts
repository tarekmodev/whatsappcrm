import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AiModule } from './ai/ai.module';
import { AssignmentModule } from './assignment/assignment.module';
import { AuditModule } from './audit/audit.module';
import { BillingModule } from './billing/billing.module';
import { CannedResponsesModule } from './canned-responses/canned-responses.module';
import { TenantContextMiddleware } from './common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { RequestPipelineModule } from './common/request-pipeline/request-pipeline.module';
import { ContactsModule } from './contacts/contacts.module';
import { ConversationsModule } from './conversations/conversations.module';
import { validateEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { MediaModule } from './media/media.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ObservabilityModule } from './observability/observability.module';
import { RequestLoggingMiddleware } from './observability/request-logging.middleware';
import { PeopleModule } from './people/people.module';
import { PlatformSettingsModule } from './platform-settings/platform-settings.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RbacModule } from './rbac/rbac.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ReportingModule } from './reporting/reporting.module';
import { REPOSITORY_ENV_FILE } from './repository-env-file';
import { SignupModule } from './signup/signup.module';
import { SlaModule } from './sla/sla.module';
import { TagsModule } from './tags/tags.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { TicketsModule } from './tickets/tickets.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { WorkflowsModule } from './workflows/workflows.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: [REPOSITORY_ENV_FILE],
      // The suite must never read a developer's `.env`. A test whose result
      // depends on whether someone happens to have Postgres running locally is
      // not a test, and the readiness specs assert the unconfigured case.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    // The in-process bus TAR-39 chose for same-request fan-out where loss is
    // acceptable — the realtime relay is its first consumer. Anything that must
    // survive a restart goes on BullMQ instead, through `QueueModule`.
    EventEmitterModule.forRoot(),
    TenantContextModule,
    ObservabilityModule,
    PrismaModule,
    // Before every module that reads a managed value (TAR-816). Global, so
    // nothing below has to import it; declared here so the boot-time snapshot
    // load is visible in the order the modules initialise.
    PlatformSettingsModule,
    QueueModule,
    AuditModule,
    // Before `RbacModule`, which binds `PRINCIPAL_SOURCE` to the session source
    // this module provides. Both are global and neither imports the other, so
    // the order here is a readability choice rather than a requirement — but it
    // is the order the request pipeline resolves them in.
    IdentityModule,
    RbacModule,
    // Last of the cross-cutting modules, and after the two above on purpose: it
    // installs the guards they provide on every route in every module below.
    // Nothing imports it — importing it is what a feature module used to have to
    // remember, and forgetting is the failure it exists to remove.
    RequestPipelineModule,
    HealthModule,
    // Platform layer, beside the pipeline rather than above it: it subscribes to
    // the domain bus and imports no feature module, so it can sit before the
    // producers whose events it relays without a cycle.
    RealtimeModule,
    TenancyModule,
    // After `TenancyModule`, whose provisioning it drives. Public self-signup is
    // the one surface that runs before a tenant exists (TAR-405).
    SignupModule,
    PeopleModule,
    // The contact taxonomy, before the module whose contacts wear it. Neither
    // imports the other — `ContactsService` reaches tags through `TenantPrisma`
    // — so the ordering here is readability, not a dependency.
    TagsModule,
    ContactsModule,
    WhatsAppModule,
    TicketsModule,
    // After `TicketsModule`, whose tickets it routes. It imports neither that
    // module nor `PeopleModule` — the rows it reads it reads through
    // `TenantPrisma`, so the ordering here is readability, not a dependency.
    AssignmentModule,
    MediaModule,
    // After `WhatsAppModule` and `MediaModule`, which it imports for the send
    // path and for turning a `mediaId` into a handle Meta holds.
    ConversationsModule,
    // Beside `ConversationsModule` rather than inside it: the library is tenant
    // configuration a supervisor curates, and its only consumer is the console
    // — the composer reads it over HTTP and resolves a typed shortcut locally
    // (0011, decision 1), so nothing in the send path imports it.
    CannedResponsesModule,
    WebhooksModule,
    // L4, and last: they may import the domain modules below them, and nothing
    // below may import them. Every trigger reaching either is a queue job for
    // exactly that reason.
    SlaModule,
    // L4 as well, and after `SlaModule` only for readability — it imports
    // nothing and nothing imports it. Reporting is a synchronous read over
    // `tickets` through `TenantPrisma`: no queue, no worker, no event.
    ReportingModule,
    // L4, beside `SlaModule` rather than above it: the two share no data and
    // neither imports the other, which is 0009 decision 1's whole argument for a
    // separate failure domain — a tenant's malformed workflow must not be able
    // to fail the job that detects SLA breaches. Unlike the two above it, it
    // *does* import `TicketsModule` (L3), because its actions write ticket
    // status, priority and assignment through the one implementation of those
    // writes.
    WorkflowsModule,
    // The generalised inbox over the rows the two L4 modules above write
    // (0009 decision 7). Declared after them because that is what it reads, not
    // because it imports them — it imports nothing, and nothing imports it.
    NotificationsModule,
    // Imports `ConversationsModule` for the send path and `EntitlementsModule`
    // for the plan gate — both declared above it, so the ordering here matches
    // the dependency rather than only reading well.
    AiModule,
    // Last, and after every module it reads from: `EntitlementsModule` for the
    // counts, `TenancyModule` for the lifecycle seam dunning runs through,
    // `WebhooksModule` for the one store-then-enqueue table, `IdentityModule`
    // for the mailer and the host resolver. Nothing imports it back — the two
    // paths that feed it arrive on the domain bus, which is what keeps identity,
    // people and webhooks free of any knowledge that billing exists.
    BillingModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the ones later stories add — a route that escapes
    // the tenant context scope is a route with no tenant isolation.
    // `{*path}` is the path-to-regexp v8 spelling of the old `*` wildcard.
    //
    // Order matters: request logging must run *inside* the context scope the
    // tenant middleware opens, or every request line loses its `requestId` and
    // `tenantId`.
    consumer.apply(TenantContextMiddleware, RequestLoggingMiddleware).forRoutes('{*path}');
  }
}
