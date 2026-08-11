import { HttpException } from '@nestjs/common';
import {
  httpStatusForErrorCode,
  type ApiErrorCode,
  type ApiErrorDetail,
} from '@whatsappcrm/contracts';

/**
 * A failure the caller is allowed to see, carrying a code from the published
 * taxonomy rather than an ad-hoc message and a hand-picked status.
 *
 * The status comes from `httpStatusForErrorCode`, which is what stops the same
 * condition answering 403 on one endpoint and 404 on another. The rendered
 * body is `ApiExceptionFilter`'s job — this type carries the facts, not the
 * envelope, so the filter can add the request id it alone can reach.
 *
 * Scope note: TAR-41 owns the *global* exception filter and the mapping of
 * everything else — Prisma errors, unhandled throws — into the same envelope.
 * This type and its filter are the minimum needed for the routes that exist
 * today to honour the published error contract, and are meant to be adopted by
 * that work rather than replaced.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: readonly ApiErrorDetail[],
  ) {
    // The payload carries the code rather than only the message, so the taxonomy
    // survives whichever filter renders it. `ApiExceptionFilter` reads `code` off
    // the instance, but a global pipeline guard (TAR-58) throws on routes whose
    // controller may not have declared that filter, and `AllExceptionsFilter`
    // then falls back to deriving a code from the status — turning
    // `unauthenticated` into `unauthorized`. Nest keeps `message` in sync with
    // the `message` key, so nothing else about the exception changes.
    super({ code, message, ...(details ? { details } : {}) }, httpStatusForErrorCode(code));
  }
}
