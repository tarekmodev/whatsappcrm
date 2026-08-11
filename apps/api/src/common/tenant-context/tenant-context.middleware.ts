import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Opens a tenant context scope for the lifetime of every HTTP request.
 *
 * `tenantId` and `userId` are intentionally left `null`: resolving them requires
 * the verified session, which TAR-35 owns. That work attaches a guard that calls
 * `TenantContextService.setTenant()` on the scope this middleware opened.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);

    this.tenantContext.run({ requestId, tenantId: null, userId: null, principal: null }, () => {
      next();
    });
  }
}
