/**
 * Typed failures `TagsService` raises, mapped to error codes in `tags.http.ts`.
 *
 * Domain errors rather than `ApiException`s from the service layer, on
 * `people.errors.ts`' reasoning: `ContactsService` drives this service's
 * reference check as well as HTTP does, and a fixture has no response to put a
 * status on.
 */

/**
 * `POST /api/v1/tags` hitting `tags (tenant_id, name)`.
 *
 * **The uniqueness is case-*sensitive*, unlike teams and routing rules.**
 * `teams.name` and `assignment_rules.name` are `citext`; `tags.name` is plain
 * `text`, so `VIP` and `vip` are two tags a tenant can genuinely hold. The
 * message says so rather than claiming a case-insensitivity that is not there —
 * telling an agent "VIP already exists" when they typed "vip" and it was
 * accepted would be worse than saying nothing. Making the column `citext` is a
 * retype on a table three others reference, so it is raised for the schema owner
 * rather than done here.
 */
export class TagNameTakenError extends Error {
  constructor(readonly tagName: string) {
    super(`A tag named ${tagName} already exists in this tenant.`);
    this.name = 'TagNameTakenError';
  }
}

/**
 * A `tagIds` entry naming a tag that is not in this tenant.
 *
 * `validation_failed` naming the field, never `not_found`: row-level security
 * means another tenant's tag is simply not visible, so the server cannot tell it
 * from a tag that never existed — and that indistinguishability is the point.
 * The refusal says which field is wrong and confirms nothing about the id.
 */
export class UnknownTagError extends Error {
  constructor(readonly tagIds: readonly string[]) {
    super(`Unknown tag: ${tagIds.join(', ')}.`);
    this.name = 'UnknownTagError';
  }
}
