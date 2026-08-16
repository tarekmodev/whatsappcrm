import { Resolver } from 'node:dns/promises';
import { Injectable } from '@nestjs/common';

/**
 * Reading the TXT records at a name, as a port.
 *
 * One method, because that is the entire question ownership verification asks.
 * A port rather than a direct `dns.resolveTxt` call for one reason that matters:
 * the verification rules — what counts as proof, what a mismatch is, how a
 * timeout is classified — are the interesting logic, and a test that has to run
 * a real DNS server to reach them is a test nobody runs.
 *
 * Implementations resolve against the **public** resolver chain, never the
 * process's `/etc/hosts` or a search-domain suffix: a claim must be proved by
 * what the internet can see, not by what this container happens to resolve.
 */
export interface DnsChallengeResolver {
  /**
   * Every TXT record at `name`, each as its concatenated character strings.
   *
   * Rejects rather than answering empty when the name does not exist — the two
   * are different states and only the caller can decide what each means.
   */
  resolveTxt(name: string): Promise<string[][]>;
}

/** Inject with `@Inject(DNS_CHALLENGE_RESOLVER)`. */
export const DNS_CHALLENGE_RESOLVER = Symbol('DNS_CHALLENGE_RESOLVER');

/**
 * The real thing: Node's own resolver, with a hard timeout and a single try.
 *
 * `tries: 1` deliberately. Node's default is four attempts with its own
 * backoff, which turns a dead resolver into a wait several times the timeout —
 * and this call sits on a request path a tenant is watching. Retrying is the
 * sweeper's job, on its own schedule, with the attempt count recorded.
 *
 * A fresh `Resolver` per lookup rather than a shared one: `Resolver` holds a
 * c-ares channel and `cancel()` is its only teardown, so sharing one across
 * concurrent verifications would make one caller's timeout cancel another's
 * query.
 */
@Injectable()
export class NodeDnsChallengeResolver implements DnsChallengeResolver {
  constructor(private readonly timeoutMs: number) {}

  async resolveTxt(name: string): Promise<string[][]> {
    const resolver = new Resolver({ timeout: this.timeoutMs, tries: 1 });

    try {
      return await resolver.resolveTxt(name);
    } finally {
      resolver.cancel();
    }
  }
}
