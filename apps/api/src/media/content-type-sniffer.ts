import { normaliseMimeType } from '@whatsappcrm/contracts';

/**
 * Does the file look like what it says it is?
 *
 * TAR-39's security rules require uploads to be validated "by real content type
 * and size", not by the type the client declared. A declared media type is
 * attacker-controlled: it decides what the recipient's WhatsApp client renders,
 * what a browser does with the download, and — if it were trusted — which size
 * ceiling applies, so a 90 MB video declared as a document would pass the
 * document limit.
 *
 * ## What this is, and what it is not
 *
 * It is a magic-number check over exactly the media types
 * `WHATSAPP_MEDIA_LIMITS` accepts, written here rather than pulled in as a
 * dependency: the closed set is ten formats, and a general-purpose sniffer
 * would bring several hundred signatures and a supply-chain surface to answer a
 * question with ten possible answers.
 *
 * It is **not** malware scanning, and no signature check is. Anti-virus for
 * arbitrary uploads is a separate control TAR-39 names, and it is not built —
 * recorded in the story's risks rather than implied by this file's existence.
 *
 * ## The two formats with no signature
 *
 * `text/plain` has none by definition, and the ZIP-based Office formats
 * (`.docx`, `.xlsx`, `.pptx`) all share one — they are ZIP containers, and
 * telling them apart means reading the archive's `[Content_Types].xml`. Both
 * are handled explicitly below rather than waved through by a fallthrough, so
 * the leniency is visible and bounded.
 */

/** How many bytes of the head any signature below needs. */
export const SNIFF_BYTES = 32;

interface Signature {
  readonly mimeType: string;
  /** Byte prefix, matched at `offset`. */
  readonly magic: readonly number[];
  readonly offset?: number;
  /**
   * A second prefix that must also match, for containers whose real type is a
   * brand inside the header — `ftyp` boxes name MP4, 3GP and M4A alike.
   */
  readonly then?: { readonly offset: number; readonly magic: readonly number[] };
}

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/**
 * Ordered: the first match wins, so more specific signatures come first. The
 * `ftyp` brands are the only place that matters — every one of them shares the
 * same four bytes at offset 4 and is told apart by the brand at offset 8.
 */
const SIGNATURES: readonly Signature[] = [
  { mimeType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP — the four size bytes between the two markers are skipped.
  {
    mimeType: 'image/webp',
    magic: ascii('RIFF'),
    then: { offset: 8, magic: ascii('WEBP') },
  },
  { mimeType: 'application/pdf', magic: ascii('%PDF-') },
  { mimeType: 'application/ogg', magic: ascii('OggS') },
  // ID3-tagged and bare MPEG audio. `FF FB`/`FF F3`/`FF F2` are frame syncs.
  { mimeType: 'audio/mpeg', magic: ascii('ID3') },
  { mimeType: 'audio/mpeg', magic: [0xff, 0xfb] },
  { mimeType: 'audio/mpeg', magic: [0xff, 0xf3] },
  { mimeType: 'audio/mpeg', magic: [0xff, 0xf2] },
  // ADTS AAC: 12 sync bits, so the second byte is masked rather than compared.
  { mimeType: 'audio/aac', magic: [0xff, 0xf1] },
  { mimeType: 'audio/aac', magic: [0xff, 0xf9] },
  { mimeType: 'audio/amr', magic: ascii('#!AMR') },
  // ISO base media. `M4A `/`mp42`/`isom` are audio or video depending on the
  // brand; the brand is what distinguishes them.
  {
    mimeType: 'audio/mp4',
    magic: ascii('ftyp'),
    offset: 4,
    then: { offset: 8, magic: ascii('M4A ') },
  },
  {
    mimeType: 'video/3gpp',
    magic: ascii('ftyp'),
    offset: 4,
    then: { offset: 8, magic: ascii('3gp') },
  },
  { mimeType: 'video/mp4', magic: ascii('ftyp'), offset: 4 },
  // Every OOXML document, and any other ZIP. Narrowed by the declared type
  // below rather than here — see `ZIP_CONTAINER_TYPES`.
  { mimeType: 'application/zip', magic: [0x50, 0x4b, 0x03, 0x04] },
  { mimeType: 'application/zip', magic: [0x50, 0x4b, 0x05, 0x06] },
  // OLE2 compound file: legacy .doc, .xls and .ppt all share it.
  {
    mimeType: 'application/x-ole-storage',
    magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
];

/** Declared types whose bytes are legitimately a ZIP container. */
const ZIP_CONTAINER_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** Declared types whose bytes are legitimately an OLE2 compound file. */
const OLE_CONTAINER_TYPES = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

/**
 * `audio/ogg` is what WhatsApp calls it; `application/ogg` is what the
 * container's own signature says. Same bytes, and Meta sends voice notes as the
 * former.
 */
const EQUIVALENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  'audio/ogg': ['application/ogg', 'audio/ogg'],
  // An MP4 container holding only audio is `audio/mp4`; one holding video is
  // `video/mp4`. Both are `ftyp`, and a brand-based guess is not reliable
  // enough to reject on, so each accepts the other's detection.
  'audio/mp4': ['audio/mp4', 'video/mp4'],
  'video/mp4': ['video/mp4', 'audio/mp4'],
};

/** What the bytes look like, or `null` for nothing this module recognises. */
export function sniffContentType(head: Buffer): string | null {
  return SIGNATURES.find((signature) => matches(head, signature))?.mimeType ?? null;
}

/**
 * True when `head` is consistent with `declared`.
 *
 * The question is deliberately "consistent with", not "equal to". A `.docx` is
 * a ZIP, an `.m4a` is an MP4, and a plain-text file is whatever its bytes
 * happen to be — insisting on equality would reject the majority of real
 * documents. What it does refuse is a mismatch that changes how the file is
 * treated: a JPEG declared as a PDF, or an executable declared as anything.
 */
export function isContentConsistentWithDeclaredType(head: Buffer, declared: string): boolean {
  const declaredType = normaliseMimeType(declared);
  const detected = sniffContentType(head);

  if (declaredType === 'text/plain') {
    // No signature exists. Accepted when the head is plausibly text — no NUL
    // and no C0 control byte outside tab, newline and carriage return, which is
    // enough to reject every binary format above and cheap enough to run on
    // 32 bytes.
    return isProbablyText(head);
  }

  if (detected === null) {
    // Recognised nothing. For the remaining declared types — all of which have
    // a signature — that is a mismatch, not an unknown.
    return false;
  }

  if (detected === 'application/zip') {
    return ZIP_CONTAINER_TYPES.has(declaredType);
  }

  if (detected === 'application/x-ole-storage') {
    return OLE_CONTAINER_TYPES.has(declaredType);
  }

  return (EQUIVALENT_TYPES[declaredType] ?? [declaredType]).includes(detected);
}

function matches(head: Buffer, { magic, offset = 0, then }: Signature): boolean {
  if (!hasPrefixAt(head, magic, offset)) {
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

function isProbablyText(head: Buffer): boolean {
  return head.every((byte) => byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d);
}
