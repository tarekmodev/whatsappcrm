import { ApiException } from '../common/errors/api.exception';
import { TagNameTakenError, UnknownTagError } from './tags.errors';

/**
 * The one place a tag-domain failure becomes an HTTP answer, on
 * `people.http.ts`' pattern and for the same reason: written once, so the same
 * condition cannot answer 409 on one route and 400 on another.
 *
 * No new error code — `validation_failed` and `conflict` cover both refusals the
 * tag surface has. Anything unrecognised is rethrown untouched: it is a fault,
 * and reporting a database outage as a validation error would hide it.
 */
export function translateTagFailure(error: unknown): never {
  if (error instanceof UnknownTagError) {
    throw new ApiException(
      'validation_failed',
      error.message,
      error.tagIds.map((tagId) => ({ path: 'tagIds', message: `${tagId} is not in this tenant.` })),
    );
  }

  if (error instanceof TagNameTakenError) {
    throw new ApiException('conflict', error.message);
  }

  throw error;
}
