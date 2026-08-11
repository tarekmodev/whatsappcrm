import { Inject, Injectable } from '@nestjs/common';
import type { SessionPrincipal } from '@whatsappcrm/contracts';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { isVisible } from '../rbac/visibility';

/**
 * The two columns the visibility rule reads, and not one more. Naming the
 * projection here is what stops a `conversation.subscribe` check from loading a
 * whole thread row to answer a yes/no question.
 */
const ACCESS_PROJECTION = {
  id: true,
  assignedUserId: true,
  assignedTeamId: true,
} as const;

/**
 * May this caller join `conversation:{id}`?
 *
 * Rooms are the isolation boundary, so this is the only place a client's own
 * input decides which room a socket ends up in — and therefore the place where
 * getting it wrong leaks another tenant's inbox. Two independent mechanisms
 * answer it, composed rather than chosen between:
 *
 *   * **Tenancy** is `TenantPrisma`: the lookup runs under the GUC that TAR-48's
 *     row-level security reads, so a conversation id belonging to another tenant
 *     matches zero rows and is indistinguishable from one that never existed.
 *     Nothing here compares tenant ids by hand, because a comparison is
 *     something a future edit can drop and a policy is not.
 *   * **Visibility inside the tenant** is `isVisible` from TAR-22 — the same
 *     function the conversation list endpoint applies, imported rather than
 *     restated. An agent without `conversation:read_all` may subscribe to the
 *     threads assigned to them or to a team they are in, and to nothing else.
 *
 * A refusal is one boolean, uniform across "no such conversation", "another
 * tenant's" and "not yours". Telling them apart would turn the subscribe channel
 * into an oracle for which conversation ids exist.
 */
@Injectable()
export class ConversationAccessService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * Whether `principal` may subscribe to `conversationId`.
   *
   * Requires the caller's tenant to be in scope already — the gateway opens that
   * scope from the handshake's principal, never from anything the subscribe
   * payload carries.
   */
  async maySubscribe(principal: SessionPrincipal, conversationId: string): Promise<boolean> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: ACCESS_PROJECTION,
    });

    return conversation !== null && isVisible(conversation, principal, 'conversation:read_all');
  }
}
