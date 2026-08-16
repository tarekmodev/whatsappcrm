/**
 * The one hostname rule that cannot live in `@whatsappcrm/contracts`.
 *
 * Everything else a claim has to satisfy — ASCII, label shape, no IP literal, no
 * apex — is published in `CustomHostnameInputSchema`, because a client can and
 * should pre-check it. This rule is different: it compares the claim against
 * `PLATFORM_DOMAIN`, which is deployment configuration and is deliberately not
 * shipped to the browser. Publishing it would tell an anonymous caller what the
 * platform's own zone is, and enforcing it client-side would be enforcing it
 * nowhere.
 *
 * It is the rule that stops a tenant claiming `rival.app.example.com` — a host
 * under the zone we issue platform subdomains from, which we would then attach a
 * certificate to and route to them.
 */

/**
 * True when `hostname` is the platform zone itself or anything under it.
 *
 * Suffix-matched on a leading dot rather than with `endsWith(platformDomain)`,
 * which would also match `notapp.example.com` for a platform domain of
 * `app.example.com` — refusing a hostname a tenant legitimately owns.
 */
export function isPlatformHostname(hostname: string, platformDomain: string): boolean {
  const zone = platformDomain.trim().toLowerCase();
  const candidate = hostname.trim().toLowerCase();

  return candidate === zone || candidate.endsWith(`.${zone}`);
}

/**
 * The fewest labels a routable claim can have.
 *
 * Three, because a claim needs a `CNAME` and **a root domain cannot take one**.
 * `docs/runbooks/custom-domains.md` states apex domains are refused for exactly
 * this reason, and `DomainRoutingSchema` hands every claimant a CNAME target —
 * so accepting `acme.com` produces a claim that verifies (a TXT record at an
 * apex is fine) and then can never be pointed at us. It sits in the operator's
 * activation queue forever, which is the one queue this feature depends on
 * somebody actually reading.
 */
const MINIMUM_HOSTNAME_LABELS = 3;

/**
 * True when the claim looks like a registrable domain rather than a subdomain of
 * one.
 *
 * ## Why this is here and not in `CustomHostnameInputSchema`
 *
 * The published schema requires two labels, and the console (TAR-418) ships
 * against it. Tightening a contract another tier already validates against is a
 * breaking change to a shared package, and this rule does not need to be one:
 * refusing here answers `validation_failed` with a message naming the fix, which
 * is the same thing a client-side check would have produced, one round trip
 * later. It sits beside the `PLATFORM_DOMAIN` rule because both are "things the
 * server knows that the wire format does not".
 *
 * ## The limit of the heuristic, stated rather than hidden
 *
 * Telling an apex from a subdomain **exactly** needs a Public Suffix List —
 * `acme.co.uk` is an apex and has three labels, so it is accepted here and will
 * never route. That is the same inert end state as a claim whose DNS was never
 * published, and it is named in the runbook's "Open" section. Counting labels
 * refuses the overwhelmingly common apex form without carrying a data file that
 * has to be kept current; a PSL lookup is the upgrade, not a rewrite.
 */
export function isApexHostname(hostname: string): boolean {
  return hostname.trim().split('.').length < MINIMUM_HOSTNAME_LABELS;
}
