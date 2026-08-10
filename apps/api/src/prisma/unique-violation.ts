import { Prisma } from '../generated/prisma/client';

/**
 * Recognising *which* unique index a write collided with.
 *
 * A table with two unique constraints — `whatsapp_business_accounts` has
 * `waba_id` and `(tenant_id, id)`, a tenant has `slug` and its domain's
 * `hostname` — produces the same `P2002` for both, and the two mean different
 * things to the caller. Reporting either as a generic conflict tells an operator
 * nothing they can act on.
 *
 * ## Why this reads two places
 *
 * Prisma records the failing constraint in one of two shapes depending on how it
 * reached the database. The engine path fills `meta.target` with the column
 * list; the `@prisma/adapter-pg` driver path this application uses leaves
 * `meta.target` undefined and carries Postgres's own message instead:
 *
 *     meta.driverAdapterError.cause.originalMessage
 *       = 'duplicate key value violates unique constraint "whatsapp_business_accounts_waba_id_key"'
 *
 * Both are searched, so the check survives a driver change in either direction
 * rather than silently classifying every collision as a fault. Matching on the
 * column name works for both spellings, because Prisma's generated index names
 * contain the columns they cover.
 */
export function isUniqueViolationOn(error: unknown, column: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    describeFailedConstraint(error).includes(column)
  );
}

/** Everything the client will say about which constraint failed, as one string. */
function describeFailedConstraint(error: Prisma.PrismaClientKnownRequestError): string {
  const meta: Record<string, unknown> = error.meta ?? {};
  const target: unknown = meta.target;

  return [
    Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '',
    driverMessageOf(meta),
  ].join(' ');
}

function driverMessageOf(meta: Record<string, unknown>): string {
  const cause: unknown = asRecord(meta.driverAdapterError)?.cause;
  const message: unknown = asRecord(cause)?.originalMessage;

  return typeof message === 'string' ? message : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
