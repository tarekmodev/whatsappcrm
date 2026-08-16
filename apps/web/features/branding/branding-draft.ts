import {
  BRANDING_DEFAULTS,
  contrastRatio,
  onAccentFor,
  type BrandingUpdateInput,
  type TenantBranding,
} from '@whatsappcrm/contracts';

/**
 * The branding form's editable state, and the rules for turning it into a valid
 * request.
 *
 * Split out of the component for the usual reason — a pure function is testable
 * where a `useState` is not — and because two of these rules are easy to get
 * subtly wrong: an empty support email is `null` rather than `''`, and a colour
 * the user has half-typed must not be sent as a colour.
 */

/** Every value is a string, because every value comes from a text control. */
export interface BrandingDraft {
  readonly productName: string;
  readonly supportEmail: string;
  readonly primaryColor: string;
  readonly accentColor: string;
}

export interface BrandingDraftErrors {
  productName?: string;
  supportEmail?: string;
  primaryColor?: string;
  accentColor?: string;
}

export const BRANDING_PRODUCT_NAME_MAX = 60;

/** `HexColorSchema`'s pattern, restated so the form can check without a parse. */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * Deliberately permissive, and only ever used to decide whether to *send* the
 * field. The address is validated properly by `BrandingUpdateInputSchema` on the
 * way out and by the API on the way in; a stricter regular expression here would
 * refuse valid addresses the server accepts, which is the worse failure.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function brandingDraftFrom(branding: TenantBranding): BrandingDraft {
  return {
    productName: branding.productName,
    supportEmail: branding.supportEmail ?? '',
    primaryColor: branding.primaryColor,
    accentColor: branding.accentColor,
  };
}

export function validateBrandingDraft(
  draft: BrandingDraft,
  copy: BrandingCopy,
): BrandingDraftErrors {
  const errors: BrandingDraftErrors = {};

  if (draft.productName.trim().length === 0) {
    errors.productName = copy.productNameRequired;
  } else if (draft.productName.trim().length > BRANDING_PRODUCT_NAME_MAX) {
    errors.productName = copy.productNameTooLong(BRANDING_PRODUCT_NAME_MAX);
  }

  if (draft.supportEmail.trim().length > 0 && !EMAIL_SHAPE.test(draft.supportEmail.trim())) {
    errors.supportEmail = copy.supportEmailInvalid;
  }

  if (!HEX_COLOUR.test(draft.primaryColor)) {
    errors.primaryColor = copy.colorInvalid;
  }

  if (!HEX_COLOUR.test(draft.accentColor)) {
    errors.accentColor = copy.colorInvalid;
  }

  return errors;
}

/** The copy validation needs, passed in so this module stays free of the content layer. */
export interface BrandingCopy {
  readonly productNameRequired: string;
  readonly productNameTooLong: (max: number) => string;
  readonly supportEmailInvalid: string;
  readonly colorInvalid: string;
}

export function hasBrandingErrors(errors: BrandingDraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The draft as `PATCH /v1/tenant` wants it.
 *
 * An empty support email becomes `null`, not `''`: the column is nullable and the
 * schema refuses an empty string, so sending one would fail validation on a field
 * the user deliberately cleared.
 */
export function brandingUpdateFrom(draft: BrandingDraft): BrandingUpdateInput {
  const supportEmail = draft.supportEmail.trim();

  return {
    productName: draft.productName.trim(),
    primaryColor: draft.primaryColor.toLowerCase(),
    accentColor: draft.accentColor.toLowerCase(),
    supportEmail: supportEmail.length === 0 ? null : supportEmail,
  };
}

/**
 * The draft as a full branding record, for the live preview.
 *
 * A colour that is still being typed falls back to the *saved* value rather than
 * to the platform default, so the preview does not flash green every time
 * somebody clears the field to paste a new hex. Assets ride along unchanged —
 * they are set by their own routes and are not part of this form.
 */
export function previewBrandingFrom(draft: BrandingDraft, saved: TenantBranding): TenantBranding {
  return {
    ...saved,
    productName: draft.productName.trim().length === 0 ? saved.productName : draft.productName,
    supportEmail: saved.supportEmail,
    primaryColor: HEX_COLOUR.test(draft.primaryColor)
      ? draft.primaryColor.toLowerCase()
      : saved.primaryColor,
    accentColor: HEX_COLOUR.test(draft.accentColor)
      ? draft.accentColor.toLowerCase()
      : saved.accentColor,
  };
}

export interface AccentReadout {
  /** The achieved contrast, after the console has chosen the text colour. */
  readonly ratio: number;
  /**
   * True when white text would *not* have cleared AA on this colour, so the
   * console switched to dark text to keep it readable.
   *
   * This is the distinction worth telling an admin about, and it is the only one
   * available: the ratio alone is always ≥ 4.5 by construction, because
   * `onAccentFor` picks whichever of its three candidates contrasts hardest. A
   * readout built on the ratio alone would have a branch that can never be
   * reached — it would always say "passes", whatever was typed.
   */
  readonly isAdjusted: boolean;
}

/**
 * What a colour scores, and whether the console had to correct around it.
 *
 * Reported, never enforced: `brandCssVariables` guarantees AA whatever the tenant
 * picks, so an adjusted colour is a taste question rather than a broken screen.
 * Telling an admin "we switched to dark text on this" is more useful than
 * silently doing it, and far more useful than refusing to save it.
 *
 * `null` while the value is not a colour yet — there is nothing to score, and a
 * score of 1:1 for a half-typed hex reads as a verdict.
 */
export function accentReadout(colour: string): AccentReadout | null {
  if (!HEX_COLOUR.test(colour)) {
    return null;
  }

  const onAccent = onAccentFor(colour);

  return {
    ratio: contrastRatio(onAccent, colour),
    // White is the colour a brand guide assumes sits on the accent; anything
    // else means we moved off it to keep the label legible.
    isAdjusted: onAccent !== '#ffffff',
  };
}

/** The platform's own colours, offered as the way back from a bad experiment. */
export const BRANDING_RESET_COLOURS = {
  primaryColor: BRANDING_DEFAULTS.primaryColor,
  accentColor: BRANDING_DEFAULTS.accentColor,
} as const;
