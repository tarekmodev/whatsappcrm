import { describe, expect, it } from 'vitest';
import { routes } from './routes';

describe('routes', () => {
  /**
   * The API builds the link in a password-reset email as
   * `https://{tenantHost}${RESET_PASSWORD_LINK_PATH}#token=…`, with the path
   * declared in `apps/api/src/identity/mailer/mailer.port.ts`. The console cannot
   * import that constant — the two packages do not depend on each other — so this
   * is the assertion that stops the emailed link and the page it points at
   * drifting into a 404 that only shows up in somebody's inbox.
   *
   * Promoting the constant into `@whatsappcrm/contracts` would remove the need
   * for this; it is a contract change and belongs to TAR-53, not here.
   */
  it('serves the reset page on the path the API mails out', () => {
    expect(routes.resetPassword()).toBe('/reset-password');
  });

  it('builds a query string only when there is something to put in it', () => {
    expect(routes.settingsPeople()).toBe('/settings/people');
    expect(routes.settingsPeople({ tab: 'teams' })).toBe('/settings/people?tab=teams');
  });

  it('encodes a search term rather than letting it become a second filter', () => {
    expect(routes.settingsPeople({ q: 'a&b' })).toBe('/settings/people?q=a%26b');
  });
});
