import { Module } from '@nestjs/common';
import { ConversationAccessService } from './conversation-access.service';
import { MessageResourceService } from './message-resource.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeHandshakeService } from './realtime-handshake.service';
import { RealtimeRelayService } from './realtime-relay.service';
import { TenantOriginService } from './tenant-origin.service';

/**
 * The Socket.IO gateway, its rooms and the relay that feeds them (TAR-39,
 * module map: `RealtimeModule`, TAR-69).
 *
 * An **L1 platform module**, which decides its whole shape: it may be reached by
 * the layers above but imports none of them. In particular it does not import
 * `WebhooksModule`, whose ingestion pipeline produces most of what it relays.
 * What crosses that line is a type — the interfaces in `events/domain-events.ts`
 * — and the in-process `EventEmitter2` the root module provides. An `imports`
 * edge in either direction would be the cycle the layering rule exists to
 * prevent.
 *
 * Everything else it needs is global: `RealtimeTicketService` and
 * `SessionService` from `IdentityModule`, `TenantPrisma` from `PrismaModule`,
 * `TenantContextService` from `TenantContextModule`.
 *
 * It exports nothing. A caller that wants to push something to a client emits a
 * domain event; giving anything a handle on the server would put room names back
 * in the hands of code that does not own the isolation rule.
 *
 * The Socket.IO server itself is built by `RealtimeIoAdapter`, installed in
 * `main.ts` — the server needs `WEB_ORIGIN` and, on more than one replica, a
 * Redis pub/sub pair, and neither can be expressed in a decorator.
 */
@Module({
  providers: [
    RealtimeGateway,
    RealtimeHandshakeService,
    RealtimeRelayService,
    ConversationAccessService,
    MessageResourceService,
    TenantOriginService,
  ],
})
export class RealtimeModule {}
