import { Module } from '@nestjs/common';
import { ResponseOriginService } from '../common/response-origin.service';
import { ConversationAccessService } from './conversation-access.service';
import { MessageResourceService } from './message-resource.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeHandshakeService } from './realtime-handshake.service';
import { RealtimeRelayService } from './realtime-relay.service';
import { TenantHostnameService } from './tenant-hostname.service';

/**
 * The Socket.IO gateway, its rooms and the relay that feeds them (TAR-39,
 * module map: `RealtimeModule`, TAR-69).
 *
 * An **L1 platform module**, which decides its whole shape: it may be reached by
 * the layers above but imports none of them. In particular it does not import
 * `ConversationsModule` or `WebhooksModule`, which between them produce
 * everything it relays. What crosses that line is a type — the interfaces in
 * `events/domain-events.ts` — and the in-process `EventEmitter2` the root module
 * provides. An `imports` edge in either direction would be the cycle the
 * layering rule exists to prevent.
 *
 * `ResponseOriginService` is declared here rather than imported, which is what
 * `ConversationsModule`'s own doc asks the second module that needs one to do:
 * it is a stateless reader of the scope, and importing an L3 module for one
 * provider would create exactly the edge above. `TenantHostnameService` is what
 * puts a hostname in that scope for a socket, since no request opened it.
 *
 * Everything else is global: `RealtimeTicketService` and `SessionService` from
 * `IdentityModule`, `TenantPrisma` from `PrismaModule`, `TenantContextService`
 * from `TenantContextModule`.
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
    TenantHostnameService,
    ResponseOriginService,
  ],
})
export class RealtimeModule {}
