import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AUTH_POLICY,
  type RealtimeTicketResponse,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { DEFAULT_REALTIME_URL } from '../config/env.schema';
import { generateAuthToken, hashAuthToken } from './auth-tokens';
import { RealtimeTicketUnavailableError } from './identity.errors';
import { RealtimeTicketStore, type RealtimeTicketClaims } from './realtime-ticket.store';

/**
 * Minting and spending the WebSocket handshake credential (TAR-180).
 *
 * ## Why there is a second credential at all
 *
 * The session cookie cannot make the trip. Under a white-label custom domain the
 * browser sits on the tenant's own host while the Socket.IO server is on the
 * platform host, so the cookie is third-party and modern browsers drop it — and
 * the WebSocket upgrade is the one call ADR 0002 decision 3 does *not* route
 * through the Next.js rewrite that keeps everything else first-party. The client
 * fetches a ticket over the proxy, where the cookie does work, and presents it
 * in the Socket.IO `auth` payload.
 *
 * Which makes this a bearer token in a place a cookie's protections do not
 * reach, so it is built to be worth as little as possible to whoever picks it
 * up: sixty seconds of life (`AUTH_POLICY.realtimeTicketTtlMs`), destroyed by
 * the first use, and carrying no authority beyond the tenant, user and role of
 * the session that asked for it.
 *
 * ## The caller never chooses anything
 *
 * `issue` takes the resolved principal and nothing else. There is no tenant, no
 * user id and no role anywhere in the request — a ticket parameterised by the
 * caller would be a route to a socket in somebody else's tenant, which is the
 * exact leak `packages/contracts/src/realtime.ts` refuses room names to prevent.
 */
@Injectable()
export class RealtimeTicketService {
  private readonly realtimeUrl: string;

  constructor(
    private readonly tickets: RealtimeTicketStore,
    config: ConfigService,
  ) {
    // `??` rather than trusting the schema default: `ConfigService.get` can
    // answer from `process.env`, which has not been through Zod.
    this.realtimeUrl = config.get<string>('REALTIME_URL') ?? DEFAULT_REALTIME_URL;
  }

  /**
   * A fresh ticket for `principal`, or a refusal.
   *
   * The plaintext is returned and immediately forgotten — only its digest is
   * stored — so this value exists in exactly two places: the response body and
   * whatever the client does with it next. It is never logged, and the `Cache-
   * Control: private, no-store` on the route is what keeps it out of a shared
   * cache on the way back.
   *
   * `expiresAt` is computed before the write rather than after, so the deadline
   * the client is told is never later than the one Redis is enforcing. A client
   * that connects at the published instant finds the ticket gone rather than the
   * reverse.
   */
  async issue(principal: SessionPrincipal): Promise<RealtimeTicketResponse> {
    const ticket = generateAuthToken();
    const expiresAt = new Date(Date.now() + AUTH_POLICY.realtimeTicketTtlMs);

    const stored = await this.tickets.put(
      hashAuthToken(ticket),
      {
        userId: principal.userId,
        tenantId: principal.tenantId,
        role: principal.role,
        sessionId: principal.sessionId,
      },
      AUTH_POLICY.realtimeTicketTtlMs,
    );

    if (!stored) {
      // Refusing is the honest answer, and the loud one. Handing back a ticket
      // no handshake could ever redeem would move the failure to a socket that
      // silently will not connect, three layers away from the cause.
      throw new RealtimeTicketUnavailableError();
    }

    return { ticket, expiresAt: expiresAt.toISOString(), realtimeUrl: this.realtimeUrl };
  }

  /**
   * Spends a ticket, answering what it authorises or `null`.
   *
   * The seam TAR-69's gateway calls, and it is here rather than in the gateway
   * so that "single-use" is a property of one function instead of a rule every
   * handshake path has to remember. One `null` for unknown, expired, already
   * spent and unreadable alike: the presenter holds 256 bits of uniform entropy
   * or it does not, and telling it apart buys the client nothing it could act on.
   */
  async consume(ticket: string): Promise<RealtimeTicketClaims | null> {
    return await this.tickets.consume(hashAuthToken(ticket));
  }
}
