import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { IdempotencyKeyState } from '../../generated/prisma/enums';
import { isUniqueViolationOn } from '../../prisma/unique-violation';
import { TENANT_PRISMA, type TenantPrisma } from '../../prisma/prisma.tokens';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { IdempotencyKeyReusedError, IdempotentRequestInFlightError } from './idempotency.errors';
import { hashIdempotentRequest } from './request-hash';

/**
 * How long a key is honoured, per 0002's idempotency section. After this the
 * same key is a new request rather than a replay — which is what makes a client
 * that recycles keys daily correct rather than permanently stuck on its first
 * response.
 */
const KEY_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/**
 * A caller that lost the race to its own concurrent retry sees the winner's row
 * a moment after this one was deleted or expired. One re-attempt covers that;
 * more would be a spin on a condition that does not resolve by waiting.
 */
const CLAIM_ATTEMPTS = 2;

export interface IdempotentRequest {
  /** The `Idempotency-Key` header value, as the client generated it. */
  readonly key: string;
  /** Namespaces the hash, so one key cannot replay across two endpoints. */
  readonly operation: string;
  /** What the request addresses — the conversation id for a send. */
  readonly target: string;
  /** The request body as the contract's schema parsed it. */
  readonly payload: unknown;
  /** What a first execution answers with, stored so a replay answers the same. */
  readonly statusCode: number;
}

export interface IdempotentOutcome<T> {
  readonly statusCode: number;
  readonly body: T;
  /** True when nothing was executed and this is the stored answer. */
  readonly replayed: boolean;
}

/**
 * `Idempotency-Key` handling, exactly as
 * `docs/architecture/0002-architecture-and-api-contract.md` rules it:
 *
 *   * first use — process, then store `(tenant_id, key, request_hash, status,
 *     response_body)`;
 *   * replay with the same body — return the stored response, nothing
 *     re-executes;
 *   * replay with a **different** body — `idempotency_key_reused`, 409;
 *   * keys expire after 24 hours.
 *
 * "Without this, an agent double-clicking Send during a slow Meta call sends the
 * customer two messages." That is the whole requirement, and it is why the
 * mechanism is a **row taken before the work runs** rather than a check
 * afterwards: two requests arriving in the same millisecond both find no stored
 * response, and only the unique index on `(tenant_id, key)` can decide which of
 * them proceeds. The loser is told the request is in flight rather than being
 * allowed to send a second message.
 *
 * ## Isolation
 *
 * Everything runs on `TenantPrisma`, so `idempotency_keys` is filtered by
 * TAR-48's RLS and one tenant's key can never collide with, replay or reveal
 * another's — the unique constraint is `(tenant_id, key)` for the same reason.
 * The service takes no tenant parameter; it reads the tenant in scope.
 *
 * ## A failed attempt does not burn the key
 *
 * If the work throws, the claim is released and the key is free again. The
 * alternative — leaving a `completed` row for a request that never happened —
 * would answer a client's legitimate retry with a stored response for work that
 * was never done. Releasing is safe because the work either committed its own
 * transaction or did not: there is no half-executed send to protect against, and
 * anything that *did* commit before throwing has already produced a message row
 * with its own durable state.
 *
 * ## Reclamation
 *
 * Expiry is honoured on read: a row past `expires_at` is treated as absent and
 * replaced, so the 24-hour rule holds without anything sweeping. The rows
 * themselves are left for the cross-tenant sweep the `(expires_at)` index exists
 * for, which is not this story's.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Runs `work` at most once per `(tenant, key)`, and returns what it produced —
   * or what it produced the first time.
   *
   * @throws IdempotencyKeyReusedError when the key was used for another request
   * @throws IdempotentRequestInFlightError when a first attempt is still running
   */
  async execute<T>(
    request: IdempotentRequest,
    work: () => Promise<T>,
  ): Promise<IdempotentOutcome<T>> {
    const tenantId = this.tenantContext.requireTenantId();
    const requestHash = hashIdempotentRequest(request);
    const claim = await this.claim(tenantId, request, requestHash);

    if (claim !== null) {
      return { statusCode: claim.statusCode, body: claim.body as T, replayed: true };
    }

    try {
      const body = await work();

      await this.prisma.idempotencyKey.updateMany({
        where: { tenantId, key: request.key, requestHash, state: IdempotencyKeyState.in_progress },
        data: {
          state: IdempotencyKeyState.completed,
          statusCode: request.statusCode,
          // The response as it goes on the wire. Prisma's `InputJsonValue` is
          // the narrowest type that accepts an arbitrary serialisable object,
          // and the cast is checked by the response schema at the boundary
          // rather than here.
          responseBody: body as Prisma.InputJsonValue,
        },
      });

      return { statusCode: request.statusCode, body, replayed: false };
    } catch (error) {
      await this.release(tenantId, request.key, requestHash);

      throw error;
    }
  }

  /**
   * Takes the key, or returns the stored response when this is a replay.
   *
   * `null` means the caller owns the key and must do the work. A non-null
   * result is the answer a previous, completed execution produced.
   */
  private async claim(
    tenantId: string,
    request: IdempotentRequest,
    requestHash: string,
  ): Promise<{ statusCode: number; body: unknown } | null> {
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
      const now = new Date();

      try {
        await this.prisma.idempotencyKey.create({
          data: {
            tenantId,
            key: request.key,
            requestHash,
            state: IdempotencyKeyState.in_progress,
            expiresAt: new Date(now.getTime() + KEY_LIFETIME_MS),
          },
          select: { id: true },
        });

        return null;
      } catch (error: unknown) {
        if (!isUniqueViolationOn(error, 'key')) {
          throw error;
        }
      }

      const held = await this.prisma.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId, key: request.key } },
        select: {
          requestHash: true,
          state: true,
          statusCode: true,
          responseBody: true,
          expiresAt: true,
        },
      });

      if (held === null) {
        // Released or expired between the failed insert and this read. Try
        // again; the loop bound is what stops that becoming a spin.
        continue;
      }

      if (held.expiresAt.getTime() <= now.getTime()) {
        // Past its 24 hours, so this is a new request that happens to reuse the
        // key. Guarded on `expires_at` so a concurrent caller that has already
        // replaced the row is not the one deleted.
        await this.prisma.idempotencyKey.deleteMany({
          where: { tenantId, key: request.key, expiresAt: { lte: now } },
        });

        continue;
      }

      if (held.requestHash !== requestHash) {
        throw new IdempotencyKeyReusedError(request.key);
      }

      if (held.state !== IdempotencyKeyState.completed) {
        throw new IdempotentRequestInFlightError(request.key);
      }

      return { statusCode: held.statusCode ?? request.statusCode, body: held.responseBody };
    }

    // Two claims lost to two different racing callers. Reporting it as in-flight
    // is truthful — somebody else holds the key — and the caller's retry with
    // the same key is exactly the right next move.
    throw new IdempotentRequestInFlightError(request.key);
  }

  /**
   * Frees a key whose work failed.
   *
   * Narrowed to `in_progress` **and** this caller's own hash: a row that has
   * since been completed, replaced after expiry, or claimed by a different
   * request is not this attempt's to delete.
   */
  private async release(tenantId: string, key: string, requestHash: string): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: { tenantId, key, requestHash, state: IdempotencyKeyState.in_progress },
    });
  }
}
