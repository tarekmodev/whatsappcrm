import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ApiErrorDetail } from '@whatsappcrm/contracts';
import type { ZodType } from 'zod';
import { ApiException } from '../errors/api.exception';

/**
 * Parses a request payload against a schema from `@whatsappcrm/contracts`, so
 * the shape the handler receives is the shape the contract publishes — and a
 * handler can treat its input as already correct.
 *
 * Two properties matter beyond "it validates":
 *
 *   * **The parsed value is what the handler gets**, not the raw body. Coercions
 *     and defaults declared in the schema therefore actually apply, instead of
 *     being documentation.
 *   * **Unknown keys are stripped, not rejected** (TAR-39, conventions). Zod
 *     objects strip by default, which is the behaviour a versioned API wants: a
 *     client sending a field from a newer version keeps working. Mass assignment
 *     is prevented by the strip, not by a 400.
 *
 * Applied per parameter — `@Body(new ZodValidationPipe(Schema))` — rather than
 * globally, because the global pipe belongs with the request pipeline TAR-35 and
 * TAR-41 wire up, and a global pipe needs a way to find the schema for each
 * route that does not exist yet.
 */
@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    const details: ApiErrorDetail[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    throw new ApiException('validation_failed', 'The request body failed validation.', details);
  }
}
