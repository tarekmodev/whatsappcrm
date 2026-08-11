import { Injectable, Logger } from '@nestjs/common';
import { RealtimeHandshakeSchema } from '@whatsappcrm/contracts';
import { randomUUID } from 'node:crypto';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { RealtimeTicketService } from '../identity/realtime-ticket.service';
import { SessionService } from '../identity/session.service';
import type { RealtimeSocketData } from './realtime-socket';

/**
 * Who is on the other end of a socket, decided once, at the upgrade.
 *
 * ## Three checks, and none of them trusts the client
 *
 * 1. **The ticket is spent.** `RealtimeTicketService.consume` is a `GETDEL`, so
 *    a ticket authorises exactly one socket even if two present it at the same
 *    instant. It answers claims or `null`, and `null` covers unknown, expired,
 *    already spent and unreadable alike.
 * 2. **The session behind it is still live.** The ticket froze a tenant, user
 *    and role sixty seconds ago; `SessionService.resolveBySessionId` re-reads
 *    them. This is what keeps "log this person out everywhere" from being
 *    defeated by a ticket fetched moments earlier, and it is also how a role
 *    change inside the window reaches the socket — the gateway authorises
 *    `conversation.subscribe` on `permissions` and `teamIds`, so a stale copy
 *    would be a stale authorization.
 * 3. **The two agree.** The claims and the resolved principal must name the same
 *    tenant and the same user. They cannot disagree without something being
 *    wrong — RLS already bounds the lookup to the tenant the claims named — but
 *    `PrincipalGuard` makes the same redundant comparison on the HTTP path for
 *    the same reason: an isolation check that costs two string compares is not
 *    a check to leave to a layer below.
 *
 * The whole of it runs inside a tenant scope opened from the **ticket's** tenant
 * id. Nothing a client sends names a tenant: the handshake payload is one
 * opaque string, and there is no host to resolve from on an upgrade that may
 * arrive at the platform origin from a tenant's own domain.
 *
 * ## Refusals are uniform
 *
 * Every failure returns `null` and the socket is closed with one message. A
 * handshake that distinguished "expired ticket" from "revoked session" would
 * tell the holder of a random string something about the state of an account,
 * which is the same reasoning `SessionService.resolve` documents.
 */
@Injectable()
export class RealtimeHandshakeService {
  private readonly logger = new Logger(RealtimeHandshakeService.name);

  constructor(
    private readonly tickets: RealtimeTicketService,
    private readonly sessions: SessionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The caller a handshake payload authorises, or `null`.
   *
   * `auth` is whatever the Socket.IO client put in its `auth` option — entirely
   * untrusted, and parsed rather than read field by field so a payload that is
   * a string, an array or `null` is refused at the boundary instead of throwing
   * three frames deeper.
   */
  async authenticate(auth: unknown): Promise<RealtimeSocketData | null> {
    const requestId = randomUUID();
    const handshake = RealtimeHandshakeSchema.safeParse(auth);

    if (!handshake.success) {
      return null;
    }

    const claims = await this.tickets.consume(handshake.data.ticket);

    if (claims === null) {
      return null;
    }

    return await this.tenantContext.run(
      { requestId, tenantId: claims.tenantId, userId: claims.userId, principal: null },
      async () => {
        // A deactivated tenant fails here, inside `assert_tenant_active`, rather
        // than by returning a principal nothing would then refuse.
        const principal = await this.sessions
          .resolveBySessionId(claims.sessionId)
          .catch((error: unknown) => {
            this.logger.warn(`Realtime handshake could not resolve a session: ${describe(error)}`);
            return null;
          });

        if (principal === null) {
          return null;
        }

        if (principal.tenantId !== claims.tenantId || principal.userId !== claims.userId) {
          this.logger.error(
            `Realtime ticket for session ${claims.sessionId} named a different principal than the ` +
              'session row; refusing the socket.',
          );
          return null;
        }

        return { principal, requestId };
      },
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
