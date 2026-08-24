import {
  AdminTenantCancelInputSchema,
  AdminTenantDeleteInputSchema,
  DeactivateTenantInputSchema,
  TenantSlugSchema,
} from '@whatsappcrm/contracts';
import type { InputParser } from '@/lib/actions/run-action';

/**
 * The action inputs the contract does not already publish as one object.
 *
 * Three of the tenant writes take a slug in the *path* and a body beside it, so
 * the contract has two schemas where the form has one submission. These compose
 * the published pair rather than restating either — the slug is still
 * `TenantSlugSchema`'s, the reason is still the body schema's 1–500 characters.
 *
 * Written as `InputParser`s rather than Zod schemas for the reason
 * `apps/web/lib/api/parse.ts` gives: neither app takes a direct dependency on
 * Zod, and the contract's exported schemas satisfy the structural interface.
 */

export interface SlugAndReason {
  readonly slug: string;
  readonly reason?: string;
}

/**
 * `{ slug, reason? }`.
 *
 * An empty `reason` is **dropped rather than rejected**. The field is optional
 * and an operator acting on an incident must not be blocked by one — but the body
 * schemas require at least one character when the key is present, so submitting a
 * form with the box untouched would fail validation for a value the API never
 * wanted.
 */
function slugAndReason(bodySchema: InputParser<{ reason?: string }>): InputParser<SlugAndReason> {
  return {
    safeParse(value: unknown) {
      if (typeof value !== 'object' || value === null) {
        return { success: false };
      }

      const { slug, reason } = value as { slug?: unknown; reason?: unknown };
      const parsedSlug = TenantSlugSchema.safeParse(slug);
      const trimmed = typeof reason === 'string' ? reason.trim() : '';
      const body = bodySchema.safeParse(trimmed.length === 0 ? {} : { reason: trimmed });

      if (!parsedSlug.success || !body.success) {
        return { success: false };
      }

      return { success: true, data: { slug: parsedSlug.data, ...body.data } };
    },
  };
}

export const SuspendInputParser = slugAndReason(DeactivateTenantInputSchema);
export const CancelInputParser = slugAndReason(AdminTenantCancelInputSchema);

export interface DeleteInput extends SlugAndReason {
  readonly force: boolean;
}

/**
 * `{ slug, force, reason? }` — the most dangerous input in the product.
 *
 * `force` is parsed through `AdminTenantDeleteInputSchema`, which defaults it to
 * `false`. That default is the safe one and is worth keeping rather than
 * requiring the key: a malformed submission that lost the flag schedules a
 * deletion on the retention clock instead of destroying data now.
 */
export const DeleteInputParser: InputParser<DeleteInput> = {
  safeParse(value: unknown) {
    if (typeof value !== 'object' || value === null) {
      return { success: false };
    }

    const { slug, force, reason } = value as {
      slug?: unknown;
      force?: unknown;
      reason?: unknown;
    };
    const parsedSlug = TenantSlugSchema.safeParse(slug);
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    const body = AdminTenantDeleteInputSchema.safeParse(
      trimmed.length === 0 ? { force } : { force, reason: trimmed },
    );

    if (!parsedSlug.success || !body.success) {
      return { success: false };
    }

    return { success: true, data: { slug: parsedSlug.data, ...body.data } };
  },
};
