import {
  DeactivateTenantInputSchema,
  DeactivateTenantParamsSchema,
  type DeactivateTenantInput,
} from '@whatsappcrm/contracts';
import type { InputParser } from '@/lib/actions/run-action';

/**
 * The two action inputs the contract does not already publish a single schema
 * for. Everything else on this surface uses the contract's object schema
 * directly — `AdminDomainParamsSchema`, `AdminWebhookEventParamsSchema`,
 * `AdminTenantParamsSchema` — because the API validates with the same object and
 * a second declaration is a place for the two to drift.
 *
 * Written as `InputParser`s rather than as Zod schemas for the reason
 * `lib/api/parse.ts` gives: `apps/web` has no direct dependency on Zod, and the
 * contract's exported schemas satisfy the structural interface. These two
 * *compose* published schemas rather than restating their rules — the slug is
 * still `TenantSlugSchema`'s, the reason is still `DeactivateTenantInputSchema`'s
 * 1–500 characters.
 */

export interface SuspendTenantInput extends DeactivateTenantInput {
  readonly slug: string;
}

/**
 * `{ slug, reason? }` — the two halves the suspend route takes in two places,
 * as one thing the form submits.
 *
 * An empty `reason` is dropped rather than rejected. The field is optional and
 * an operator acting on an incident should not be blocked by one, but
 * `DeactivateTenantInputSchema` requires at least one character when the key is
 * present — so submitting a form with the box untouched would fail validation
 * for a value the API never wanted.
 */
export const SuspendTenantInputParser: InputParser<SuspendTenantInput> = {
  safeParse(value: unknown) {
    if (typeof value !== 'object' || value === null) {
      return { success: false };
    }

    const { slug, reason } = value as { slug?: unknown; reason?: unknown };
    const params = DeactivateTenantParamsSchema.safeParse({ slug });
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    const body = DeactivateTenantInputSchema.safeParse(
      trimmed.length === 0 ? {} : { reason: trimmed },
    );

    if (!params.success || !body.success) {
      return { success: false };
    }

    return { success: true, data: { slug: params.data.slug, ...body.data } };
  },
};

/**
 * The operator's bearer token, as typed into the credential form.
 *
 * Non-empty after trimming, and nothing else. The console must not narrow what a
 * valid token looks like: `PlatformAdminGuard` answers one refusal for an absent
 * header, a wrong scheme, a wrong token and an unconfigured environment
 * precisely so the response cannot be used to tell them apart, and a client-side
 * shape check would hand that distinction back. Whitespace is stripped because a
 * pasted secret routinely carries a trailing newline, and a credential that fails
 * for that reason is indistinguishable from a wrong one.
 */
export const PlatformCredentialParser: InputParser<string> = {
  safeParse(value: unknown) {
    const token = typeof value === 'string' ? value.trim() : '';

    return token.length === 0 ? { success: false } : { success: true, data: token };
  },
};
