/**
 * What a stored file is called, once it has been made safe to store and to send
 * back.
 *
 * A file name from an upload is user input that ends up in three places, and it
 * is dangerous in a different way in each: in a `Content-Disposition` header
 * (header injection, and a name that changes what the browser does with the
 * download), in Meta's `filename` field (what the recipient sees), and — if
 * anything ever built a path from it — on disk. Nothing here builds a path from
 * it: `mediaObjectKey` never takes a name. This is the other two.
 */

/** Long enough for any real document name, short enough not to be a payload. */
const MAX_FILE_NAME_LENGTH = 255;

/**
 * Strips everything a file name has no business containing, and returns `null`
 * when nothing usable is left.
 *
 * Rejecting rather than replacing, in that last case: an upload named `../../`
 * is not a file called `unnamed`, and inventing a name for it hides what
 * arrived. The column is nullable precisely so "no usable name" is
 * representable.
 *
 * What goes:
 *
 *   * path separators and the segments they build — a name is a leaf, never a
 *     path, and `..` is not a name;
 *   * control characters, including the CR and LF that turn a
 *     `Content-Disposition` value into two headers;
 *   * leading dots, so an upload cannot become a hidden file if a future
 *     adapter ever writes names to disk;
 *   * surrounding whitespace, which is invisible and confusing rather than
 *     dangerous.
 */
export function sanitiseFileName(candidate: string | null | undefined): string | null {
  if (candidate === null || candidate === undefined) {
    return null;
  }

  const leaf = candidate.split(/[\\/]/).pop() ?? '';

  const cleaned = [...leaf]
    // eslint-disable-next-line no-control-regex -- the point is to remove them.
    .filter((character) => !/[\u0000-\u001f\u007f]/.test(character))
    .join('')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);

  return cleaned.length === 0 ? null : cleaned;
}

/**
 * A `Content-Disposition` value that is safe to emit and correct for a
 * non-ASCII name.
 *
 * Both forms, per RFC 6266: a quoted ASCII fallback for old clients and a
 * percent-encoded UTF-8 `filename*` for everything since. The fallback is
 * stripped to ASCII rather than transliterated — a name that becomes `___` in
 * the fallback still arrives correctly through `filename*` in every browser
 * released this decade.
 *
 * `attachment`, never `inline`. An HTML or SVG file served inline from the API
 * origin is stored cross-site scripting; the disposition, together with
 * `X-Content-Type-Options: nosniff`, is what stops a download being executed as
 * a page. Nothing in `WHATSAPP_MEDIA_LIMITS` is a scriptable type today — that
 * is the belt, and this is the braces.
 */
export function contentDispositionFor(fileName: string | null): string {
  if (fileName === null) {
    return 'attachment';
  }

  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
