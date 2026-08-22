/**
 * Builds a `mailto:` URL. Usage: `mailto(webEnv.supportEmail, subject)`.
 *
 * The subject is encoded, which is the whole point: hand-concatenated the way a
 * `?subject=` usually is, one containing `&`, `#` or a space produces a draft
 * with half a subject line or none. That is the same failure `routes.ts`'s
 * `withQuery` exists to prevent, in the one place that cannot use it — `mailto:`
 * has no path for `URLSearchParams` to hang off, and `URLSearchParams` would
 * encode a space as `+`, which a mail client renders literally.
 *
 * The address is not encoded. It comes from `webEnv.supportEmail`, which is
 * shape-checked at the config boundary, and percent-encoding its `@` produces a
 * link some clients refuse.
 */
export function mailto(address: string, subject?: string): string {
  const target = `mailto:${address}`;

  return subject === undefined ? target : `${target}?subject=${encodeURIComponent(subject)}`;
}
