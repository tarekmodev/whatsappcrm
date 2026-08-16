import { DomainOwnershipChecker } from './domain-ownership.checker';
import type { DnsChallengeResolver } from './dns-challenge.resolver';

const HOSTNAME = 'support.acme.example';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const EXPECTED = `whatsappcrm-domain-verification=${TOKEN}`;

/** A resolver that answers with `records`, or rejects with a Node DNS error. */
function resolverReturning(records: string[][]): DnsChallengeResolver {
  return { resolveTxt: () => Promise.resolve(records) };
}

function resolverFailing(code: string): DnsChallengeResolver {
  return {
    resolveTxt: () => Promise.reject(Object.assign(new Error(`queryTxt ${code}`), { code })),
  };
}

describe('DomainOwnershipChecker', () => {
  it('asks for the challenge label rather than the hostname itself', async () => {
    // A TXT record at the hostname is somebody else's SPF or DKIM record; the
    // challenge lives at a label nothing else uses.
    const resolveTxt = jest.fn<Promise<string[][]>, [string]>().mockResolvedValue([[EXPECTED]]);

    await new DomainOwnershipChecker({ resolveTxt }).check(HOSTNAME, TOKEN);

    expect(resolveTxt).toHaveBeenCalledWith(`_whatsappcrm-challenge.${HOSTNAME}`);
  });

  it('proves ownership when the record is there', async () => {
    const checker = new DomainOwnershipChecker(resolverReturning([[EXPECTED]]));

    await expect(checker.check(HOSTNAME, TOKEN)).resolves.toEqual({ proved: true });
  });

  it('finds it among a zone’s other verification records', async () => {
    // Zones routinely hold half a dozen vendor tokens at one name. A match
    // anywhere is proof.
    const checker = new DomainOwnershipChecker(
      resolverReturning([['google-site-verification=abc'], ['v=spf1 -all'], [EXPECTED]]),
    );

    await expect(checker.check(HOSTNAME, TOKEN)).resolves.toEqual({ proved: true });
  });

  it('reassembles a record the resolver split into character strings', async () => {
    // A TXT record longer than 255 bytes arrives in chunks, and a naive
    // comparison against the first chunk would never match.
    const checker = new DomainOwnershipChecker(
      resolverReturning([[EXPECTED.slice(0, 20), EXPECTED.slice(20)]]),
    );

    await expect(checker.check(HOSTNAME, TOKEN)).resolves.toEqual({ proved: true });
  });

  it('refuses another tenant’s token at the same name', async () => {
    const someoneElse = `whatsappcrm-domain-verification=${'f'.repeat(32)}`;
    const checker = new DomainOwnershipChecker(resolverReturning([[someoneElse]]));

    await expect(checker.check(HOSTNAME, TOKEN)).resolves.toEqual({
      proved: false,
      reason: 'record_mismatch',
    });
  });

  it('refuses a bare token without the prefix', async () => {
    // Otherwise a hex string somebody happened to publish would satisfy us.
    const checker = new DomainOwnershipChecker(resolverReturning([[TOKEN]]));

    await expect(checker.check(HOSTNAME, TOKEN)).resolves.toMatchObject({ proved: false });
  });

  it.each([
    ['a name that does not exist', 'ENOTFOUND', 'record_not_found'],
    ['a name with no TXT records', 'ENODATA', 'record_not_found'],
    ['a resolver that timed out', 'ETIMEOUT', 'lookup_timeout'],
    ['a resolver that refused the connection', 'ECONNREFUSED', 'lookup_timeout'],
    ['anything else', 'ESERVFAIL', 'lookup_failed'],
  ])('reports %s as %s', async (_label, code, reason) => {
    const checker = new DomainOwnershipChecker(resolverFailing(code));

    await expect(checker.check(HOSTNAME, TOKEN)).resolves.toEqual({ proved: false, reason });
  });

  it('treats an empty answer as the record not being published', async () => {
    const checker = new DomainOwnershipChecker(resolverReturning([]));

    await expect(checker.check(HOSTNAME, TOKEN)).resolves.toEqual({
      proved: false,
      reason: 'record_not_found',
    });
  });

  it('never throws, because "not yet" is a state rather than a fault', async () => {
    // The endpoint answers 200 with the domain and its failure reason; an
    // exception here would make DNS not having propagated an error envelope.
    const checker = new DomainOwnershipChecker({
      resolveTxt: () => Promise.reject(new Error('something nobody modelled')),
    });

    await expect(checker.check(HOSTNAME, TOKEN)).resolves.toMatchObject({ proved: false });
  });
});
