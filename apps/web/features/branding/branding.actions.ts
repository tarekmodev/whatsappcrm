'use server';

import {
  BRANDING_ASSET_LIMITS,
  BRANDING_UPLOAD_FIELD,
  BrandingAssetKindSchema,
  BrandingUpdateInputSchema,
  type BrandingAssetKind,
  type TenantBranding,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { ActionRefusedError, runAction } from '@/lib/actions/run-action';
import { deleteBrandingAsset, updateTenant, uploadBrandingAsset } from '@/lib/api/tenant';
import type { ActionResult } from '@/lib/actions/result';

/**
 * The three branding mutations, as the browser reaches them.
 *
 * `runAction` supplies the body every action in this app shares: assert the
 * permission (a server action is a public endpoint, so the navigation gate is not
 * a gate), validate against the *contract's* schema, perform, revalidate, and
 * return a failure as a value rather than throwing one — a thrown action unmounts
 * into the route's error boundary and takes the half-edited form with it.
 *
 * All three revalidate `/` and not just the settings route. Branding is rendered
 * by the **root layout** — the rail, the top bar, the sign-in screen and the
 * document title all read it — so re-rendering only the page the admin is on
 * would leave them looking at the old logo in the chrome around their own change.
 */

export async function saveBrandingAction(input: unknown): Promise<ActionResult<TenantBranding>> {
  return runAction({
    permission: 'branding:write',
    parser: BrandingUpdateInputSchema,
    input,
    perform: async (branding) => (await updateTenant({ branding })).branding,
    revalidate: ROOT_PATH,
    label: 'Save branding',
  });
}

/**
 * The logo or favicon upload.
 *
 * It takes `FormData` rather than a `File` because that is what a server action
 * can receive from a browser without the caller serialising anything, and because
 * the same shape is what the API's multipart route wants — so the bytes are
 * forwarded rather than re-encoded.
 *
 * Buffering the file in this process is acceptable here and is not elsewhere:
 * these two assets are capped at 512 KB and 64 KB, while WhatsApp media runs to
 * 100 MB and therefore goes straight from the browser to the API
 * (`lib/api/media-browser.ts`).
 */
export async function uploadBrandingAssetAction(
  form: FormData,
): Promise<ActionResult<TenantBranding>> {
  return runAction({
    permission: 'branding:write',
    parser: null,
    input: undefined,
    perform: async () => {
      const kind = readAssetKind(form);
      const file = form.get(BRANDING_UPLOAD_FIELD);

      if (!(file instanceof File) || file.size === 0) {
        throw new ActionRefusedError(content.form.genericSubmitError);
      }

      // The browser refused an oversize or unsupported file already; this is the
      // same check on the trusted side of the boundary, because a server action
      // is reachable without going near that form. The API applies it a third
      // time and sniffs the bytes, which is the check that actually enforces it.
      assertWithinLimits(kind, file);

      return uploadBrandingAsset(kind, file);
    },
    revalidate: ROOT_PATH,
    label: 'Upload branding asset',
  });
}

export async function removeBrandingAssetAction(input: unknown): Promise<ActionResult<void>> {
  return runAction({
    permission: 'branding:write',
    parser: BrandingAssetKindSchema,
    input,
    perform: async (kind) => {
      await deleteBrandingAsset(kind);
    },
    revalidate: ROOT_PATH,
    label: 'Remove branding asset',
  });
}

/**
 * `routes.home()`, not the settings path: `revalidatePath('/')` re-renders the
 * root layout, which is where the brand tokens, the favicon and the title live.
 */
const ROOT_PATH = routes.home();

function readAssetKind(form: FormData): BrandingAssetKind {
  const parsed = BrandingAssetKindSchema.safeParse(form.get('kind'));

  if (!parsed.success) {
    throw new ActionRefusedError(content.form.genericSubmitError);
  }

  return parsed.data;
}

function assertWithinLimits(kind: BrandingAssetKind, file: File): void {
  const limits = BRANDING_ASSET_LIMITS[kind];
  const label = kind === 'logo' ? content.branding.logoLabel : content.branding.faviconLabel;

  if (!limits.mimeTypes.includes(file.type)) {
    throw new ActionRefusedError(content.branding.wrongType(label, limits.mimeTypes.join(', ')));
  }

  if (file.size > limits.maxBytes) {
    const { value, unit } = formatLimit(limits.maxBytes);

    throw new ActionRefusedError(content.branding.tooLarge(label, `${value} ${unit}`));
  }
}

/** Kept local: the caps are round numbers of KB, and this only ever phrases one. */
function formatLimit(maxBytes: number): { value: number; unit: string } {
  return { value: Math.round(maxBytes / 1024), unit: content.fileSizeUnits.kb };
}
