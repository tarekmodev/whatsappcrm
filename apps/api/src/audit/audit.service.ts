import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { resolveAuditActor } from './audit-actor';
import type { AuditAction } from './audit.actions';

/** What changed, in a shape an auditor can read six months later. */
export interface AuditEntry {
  action: AuditAction;
  targetType: 'user' | 'team' | 'invite' | 'whatsapp_business_account';
  targetId: string;
  /**
   * A redacted before/after at most. **Never a secret, a password hash, a token
   * or a message body** — this table is read by support and exported for
   * compliance review, and it is not the place to discover PII.
   */
  metadata?: Prisma.InputJsonValue;
}

/**
 * Writes the audit trail for security-relevant mutations.
 *
 * Takes the caller's transaction client rather than opening its own, which is
 * the point: the audit row commits with the change it describes, or neither
 * does. An audit written after the transaction can be lost to a crash — leaving
 * a role change nobody can account for — and one written before can describe a
 * change that then rolled back.
 *
 * `tenantId` and the actor come from the request scope, not from the caller's
 * arguments, so a service cannot accidentally attribute a change to the wrong
 * person or file it under the wrong tenant.
 *
 * Since TAR-166 the actor is three columns, not one: `actor_type` says which
 * kind of principal acted, and `actor_label` names the operator credential when
 * it was a platform operator. All three are written explicitly on every call —
 * `actor_type` has a database default, and nothing here leans on it.
 */
@Injectable()
export class AuditService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: this.tenantContext.requireTenantId(),
        ...resolveAuditActor(this.tenantContext),
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      },
      select: { id: true },
    });
  }
}
