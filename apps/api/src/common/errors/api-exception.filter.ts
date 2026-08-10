import { Catch, Injectable, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ApiError } from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { ApiException } from './api.exception';

/**
 * Renders an `ApiException` as TAR-38's error envelope.
 *
 * It exists as a filter rather than as a body baked into the exception because
 * of one field: `requestId`. That value lives in the `AsyncLocalStorage` scope
 * the tenant-context middleware opened, and reading it needs an injected
 * service — which an exception constructed deep in a service cannot have.
 *
 * Bound per controller with `@UseFilters(ApiExceptionFilter)`, deliberately not
 * globally: TAR-41 owns the global filter, and a second global filter competing
 * with it would be a merge conflict in behaviour rather than in code. Binding by
 * class rather than by instance is what lets Nest inject `TenantContextService`.
 * Anything that is not an `ApiException` falls through to Nest's default
 * handler, which is also TAR-41's to replace.
 */
@Injectable()
@Catch(ApiException)
export class ApiExceptionFilter implements ExceptionFilter<ApiException> {
  constructor(private readonly tenantContext: TenantContextService) {}

  catch(exception: ApiException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    const body: ApiError = {
      error: {
        code: exception.code,
        message: exception.message,
        // Omitted rather than sent as an empty array: the contract marks it
        // optional, and `details: []` reads as "validated, nothing wrong".
        ...(exception.details?.length ? { details: [...exception.details] } : {}),
        // `unknown` only if something threw outside a request scope, which for
        // an HTTP filter means the middleware did not run.
        requestId: this.tenantContext.requestId ?? 'unknown',
      },
    };

    response.status(exception.getStatus()).json(body);
  }
}
