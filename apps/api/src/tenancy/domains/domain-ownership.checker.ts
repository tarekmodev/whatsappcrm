import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  domainChallengeRecordName,
  domainChallengeRecordValue,
  type DomainVerificationFailureReason,
} from '@whatsappcrm/contracts';
import { DNS_CHALLENGE_RESOLVER, type DnsChallengeResolver } from './dns-challenge.resolver';

/** Proved, or not proved and why. Never a throw — "not yet" is a state, not a fault. */
export type OwnershipOutcome =
  | { readonly proved: true }
  | { readonly proved: false; readonly reason: DomainVerificationFailureReason };

/** Node's DNS errors carry the reason on `code`. */
const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);
const TIMEOUT_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED']);

/**
 * Does the tenant actually control this hostname? (TAR-29, TAR-416.)
 *
 * A DNS `TXT` record at `_whatsappcrm-challenge.<hostname>` carrying
 * `whatsappcrm-domain-verification=<token>`. Publishing that record requires
 * write access to the zone, which is the thing being proved — and it proves it
 * **before** anything is routed and before any operator step, which is what an
 * HTTP `.well-known` challenge cannot do: that one needs TLS terminated for a
 * domain we have not attached yet, so it is circular.
 *
 * ## Why the outcome is a value rather than an exception
 *
 * "The record is not there yet" is by far the most common answer — a tenant
 * clicks verify the moment they paste the record, and DNS has not propagated.
 * That is a **state on the resource**, not an error with the request, so the
 * endpoint answers 200 with the domain and its failure reason and the taxonomy
 * in `error-codes.ts` stays small. Only the reason is modelled here; what to do
 * about it belongs to the caller.
 *
 * ## What it compares
 *
 * Every returned record, and every character string within each — a TXT record
 * longer than 255 bytes arrives split, and a zone legitimately holds other TXT
 * records at the same name (SPF-style verification tokens from other vendors
 * routinely share one). So a match anywhere is proof, and only "there are
 * records here but none of them is ours" is a mismatch.
 *
 * The comparison is on the whole `whatsappcrm-domain-verification=<token>`
 * string, so another vendor's token cannot satisfy ours and ours cannot be
 * satisfied by a bare hex string somebody happened to publish.
 */
@Injectable()
export class DomainOwnershipChecker {
  private readonly logger = new Logger(DomainOwnershipChecker.name);

  constructor(@Inject(DNS_CHALLENGE_RESOLVER) private readonly resolver: DnsChallengeResolver) {}

  async check(hostname: string, token: string): Promise<OwnershipOutcome> {
    const name = domainChallengeRecordName(hostname);
    const expected = domainChallengeRecordValue(token);

    let records: string[][];

    try {
      records = await this.resolver.resolveTxt(name);
    } catch (error: unknown) {
      const reason = classify(error);

      // Only the transport failures are worth a line: a missing record is the
      // ordinary case and a tenant can drive it as often as the rate limit
      // allows, so logging it would be logging their typing.
      if (reason !== 'record_not_found') {
        this.logger.warn(`Could not resolve TXT ${name}: ${reason}`);
      }

      return { proved: false, reason };
    }

    if (records.length === 0) {
      return { proved: false, reason: 'record_not_found' };
    }

    const proved = records.some((chunks) => chunks.join('').trim() === expected);

    return proved ? { proved: true } : { proved: false, reason: 'record_mismatch' };
  }
}

/**
 * A resolver failure as one of the four published reasons.
 *
 * A name that does not exist and a name with no TXT records are both
 * `record_not_found`: to the tenant they mean the same thing — the record is not
 * published yet — and telling them apart would be reporting the shape of their
 * zone back to them. Everything unrecognised is `lookup_failed`, which is the
 * reason that says "this is ours, not yours".
 */
function classify(error: unknown): DomainVerificationFailureReason {
  const code =
    typeof error === 'object' && error !== null ? String(Reflect.get(error, 'code')) : '';

  if (NOT_FOUND_CODES.has(code)) {
    return 'record_not_found';
  }

  return TIMEOUT_CODES.has(code) ? 'lookup_timeout' : 'lookup_failed';
}
