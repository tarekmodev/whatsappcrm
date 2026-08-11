import { Injectable } from '@nestjs/common';
import { IdSchema, TenantRoleSchema } from '@whatsappcrm/contracts';
import { z } from 'zod';
import { AUTH_KEY_PREFIX, AuthRedisClient } from './auth-redis.client';

/**
 * Where a realtime ticket lives between `POST /auth/realtime-ticket` and the
 * Socket.IO handshake that spends it (TAR-180, and TAR-69 on the reading side).
 *
 * Redis rather than Postgres, and rather than process memory:
 *
 *   * **Not memory.** The socket does not have to land on the replica that
 *     issued the ticket — under ADR 0002 decision 3 it does not even connect to
 *     the same origin the ticket was fetched from — so an in-process map would
 *     make the handshake succeed or fail on which pod answered.
 *   * **Not Postgres.** The row would live for sixty seconds and then be
 *     garbage, which is a table, a migration, an RLS policy and a sweeper for a
 *     value Redis expires on its own. Nothing durable is lost when a ticket
 *     evaporates: the holder still has their session cookie and asks for
 *     another.
 *
 * ## It does not degrade, and that is the difference from `SessionCacheService`
 *
 * Every other consumer of `AuthRedisClient` has a correct answer without Redis —
 * the session cache falls back to Postgres, the failure window to the durable
 * counter. This one has none. A ticket that was never stored cannot be redeemed,
 * so issuing one anyway would hand the caller a credential guaranteed to be
 * refused at the handshake, and the failure would surface as a socket that will
 * not connect rather than as the request that actually went wrong. `put`
 * therefore reports whether the write landed and the service refuses to issue
 * when it did not.
 *
 * ## Stored as a digest, like every other token in this module
 *
 * The key is the SHA-256 of the ticket (`auth-tokens.ts`, ADR 0005 "Tokens at
 * rest"), never the plaintext. Redis holds no credential anybody could present:
 * a `KEYS` dump yields digests, and the ticket itself exists only in the
 * response body and the handshake payload.
 */

/**
 * What the ticket authorises, frozen at issue.
 *
 * The role is copied rather than re-read at handshake time because a ticket is
 * spent within a minute and the alternative — resolving the principal again
 * inside the gateway — is a second, subtly different authentication path.
 * TAR-69 still re-checks that `sessionId` is live before joining any room:
 * that is what keeps "log this person out everywhere" from being defeated by a
 * ticket fetched moments earlier, and it is also how a role change inside the
 * window is picked up.
 */
export const RealtimeTicketClaimsSchema = z.object({
  userId: IdSchema,
  tenantId: IdSchema,
  role: TenantRoleSchema,
  sessionId: IdSchema,
});

export type RealtimeTicketClaims = z.infer<typeof RealtimeTicketClaimsSchema>;

@Injectable()
export class RealtimeTicketStore {
  constructor(private readonly redis: AuthRedisClient) {}

  /**
   * Records `claims` against `ticketHash` for `ttlMs`, and says whether it
   * landed.
   *
   * `NX` so a write can only ever create. A 256-bit collision is not the reason
   * — it is that "this ticket already exists" must never resolve by quietly
   * replacing somebody else's claims, and stating it in the command is cheaper
   * than trusting the entropy and hoping.
   *
   * `false` covers no Redis, an unreachable one, and an `NX` that found the key
   * taken. All three mean the same thing to the caller: do not hand this ticket
   * out.
   */
  async put(ticketHash: string, claims: RealtimeTicketClaims, ttlMs: number): Promise<boolean> {
    const stored = await this.redis.run(
      'realtime ticket write',
      async (client) =>
        await client.set(ticketKey(ticketHash), JSON.stringify(claims), 'PX', ttlMs, 'NX'),
    );

    return stored === 'OK';
  }

  /**
   * Reads the claims and destroys the ticket in the same operation, or answers
   * `null` when there is nothing to spend.
   *
   * `GETDEL` rather than `GET` then `DEL`: single-use has to survive two sockets
   * presenting the same ticket at once, and a read followed by a delete lets
   * both of them through the gap. One round trip is also one fewer place a
   * handshake can half-fail.
   *
   * Parsed against the schema rather than cast, on `SessionCacheService`'s
   * reasoning — a deploy that changes the claim shape leaves the old one
   * readable for up to a minute, and a gateway authorising on `undefined` is
   * worse than a refused handshake. A rejected entry is simply a dead ticket,
   * and it has already been deleted.
   */
  async consume(ticketHash: string): Promise<RealtimeTicketClaims | null> {
    const stored = await this.redis.run(
      'realtime ticket consume',
      async (client) => await client.getdel(ticketKey(ticketHash)),
    );

    if (stored === null || stored === undefined) {
      return null;
    }

    const parsed = RealtimeTicketClaimsSchema.safeParse(safeJsonParse(stored));

    return parsed.success ? parsed.data : null;
  }
}

/**
 * Namespaced under the auth prefix like every other key this module writes, and
 * deliberately **not** keyed by tenant.
 *
 * The tenant is inside the value, not in the key, because the handshake arrives
 * holding nothing but the ticket — there is no host to resolve a tenant from at
 * that point, and a key the gateway would have to guess the tenant half of is a
 * key it cannot look up. Isolation comes from the claims: the socket joins the
 * tenant room the ticket names, never one the client asks for.
 */
function ticketKey(ticketHash: string): string {
  return `${AUTH_KEY_PREFIX}:rt:${ticketHash}`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
