/**
 * What a branding upload actually is, from its bytes.
 *
 * TAR-39's security rules require an upload to be validated by its **real**
 * content type, never by the one the client declared: the declared type decides
 * what a browser does with the response, and it is attacker-controlled. This is
 * the magic-number check for exactly the four image formats
 * `BRANDING_ASSET_LIMITS` accepts, and it is the authority for the
 * `Content-Type` the serve route later sets.
 *
 * ## Why this is not `media/content-type-sniffer.ts`
 *
 * That file is a closed set that says out loud it is exactly the types
 * `WHATSAPP_MEDIA_LIMITS` accepts — Meta's vocabulary, sized by Cloud API
 * limits. It has no ICO signature, because WhatsApp has no use for one, and
 * widening it so a favicon can be uploaded would make it two things at once and
 * quietly enlarge what a *message attachment* may be. Four signatures duplicated
 * is cheaper than that coupling.
 *
 * It is **not** malware scanning, and no signature check is — TAR-39 names that
 * as a separate control and it is not built here.
 */

/** How many bytes of the head any signature below needs. */
export const BRANDING_SNIFF_BYTES = 16;

interface Signature {
  readonly mimeType: string;
  readonly magic: readonly number[];
  /** A second prefix that must also match, for the RIFF container. */
  readonly then?: { readonly offset: number; readonly magic: readonly number[] };
}

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

const SIGNATURES: readonly Signature[] = [
  { mimeType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  // RIFF....WEBP — the four size bytes between the two markers are skipped.
  { mimeType: 'image/webp', magic: ascii('RIFF'), then: { offset: 8, magic: ascii('WEBP') } },
  // ICO: a zero reserved word, then image type 1. Type 2 is a cursor, which is
  // the same container and is not an icon — hence the exact four bytes rather
  // than a two-byte prefix.
  { mimeType: 'image/x-icon', magic: [0x00, 0x00, 0x01, 0x00] },
];

/** The type these bytes really are, or `null` for anything not in the allow-list. */
export function sniffBrandingImageType(head: Buffer): string | null {
  return SIGNATURES.find((signature) => matches(head, signature))?.mimeType ?? null;
}

function matches(head: Buffer, { magic, then }: Signature): boolean {
  if (!hasPrefixAt(head, magic, 0)) {
    return false;
  }

  return then === undefined || hasPrefixAt(head, then.magic, then.offset);
}

function hasPrefixAt(head: Buffer, magic: readonly number[], offset: number): boolean {
  if (head.length < offset + magic.length) {
    return false;
  }

  return magic.every((byte, index) => head[offset + index] === byte);
}
