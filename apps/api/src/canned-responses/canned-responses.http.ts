import { ApiException } from '../common/errors/api.exception';
import {
  CannedResponseNotFoundError,
  CannedResponseShortcutTakenError,
  TooManyCannedResponsesError,
} from './canned-responses.errors';

/**
 * The one place a canned-response failure becomes an HTTP answer, on
 * `assignment.http.ts`' pattern and for the same reason: written once, so the
 * same condition cannot answer 409 on one route and 400 on another.
 *
 * Anything unrecognised is rethrown untouched: it is a fault, and reporting a
 * database outage as a validation error would hide it.
 */
export function translateCannedResponseFailure(error: unknown): never {
  if (error instanceof CannedResponseNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (
    error instanceof CannedResponseShortcutTakenError ||
    error instanceof TooManyCannedResponsesError
  ) {
    throw new ApiException('conflict', error.message);
  }

  throw error;
}
