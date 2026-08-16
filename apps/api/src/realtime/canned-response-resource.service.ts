import { Inject, Injectable } from '@nestjs/common';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import {
  CANNED_RESPONSE_PROJECTION,
  toCannedResponseResponse,
} from '../canned-responses/canned-response.mapper';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * Turning a canned-response id into the resource a socket publishes (TAR-485).
 *
 * `ConversationResourceService`'s reasoning, applied to the third resource the
 * realtime contract carries whole. `canned_response.changed` carries ids because
 * the payload a socket publishes must be the committed row rather than the
 * writer's view of it; this is the read that turns one into the other, and the
 * body it returns is what lets a console update its local copy without a
 * refetch — TAR-485's second acceptance criterion.
 *
 * `CANNED_RESPONSE_PROJECTION` and `toCannedResponseResponse` are TAR-477's,
 * imported rather than restated, so `GET /canned-responses` and a relayed
 * `canned_response.saved` publish the same row identically. That import crosses
 * a layer — this is an L1 platform module and `canned-responses` is an L4 domain
 * one — and is the same category of sharing `MessageResourceService` documents
 * at length: a pure function and a projection constant, no provider, no
 * injection, no module edge.
 *
 * ## No origin, and therefore no hostname
 *
 * A `CannedResponseResponse` is text and timestamps — no absolute URL back to
 * this API — so nothing here needs `ResponseOriginService` and the relay does
 * not have to publish a hostname before calling it, exactly as for a
 * conversation.
 *
 * ## Isolation
 *
 * `TenantPrisma` under the scope the relay opened from the event's own tenant
 * id, so an id that somehow named another tenant's row resolves to nothing
 * rather than to a payload. There is no principal in that scope and no
 * permission check here on purpose: *who* may see this is decided by the room
 * the relay addresses, which every socket joined from its own principal.
 */
@Injectable()
export class CannedResponseResourceService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * The canned response as the API publishes it, or `null` when the row is gone.
   *
   * `null` is a race with a legitimate outcome rather than an error to shout
   * about — a delete that landed between the commit that emitted the event and
   * this read — and the honest response to it is to relay nothing. The
   * `canned_response.deleted` that delete emits is what makes the console
   * converge.
   */
  async findForRelay(cannedResponseId: string): Promise<CannedResponseResponse | null> {
    const row = await this.prisma.cannedResponse.findUnique({
      where: { id: cannedResponseId },
      select: CANNED_RESPONSE_PROJECTION,
    });

    return row === null ? null : toCannedResponseResponse(row);
  }
}
