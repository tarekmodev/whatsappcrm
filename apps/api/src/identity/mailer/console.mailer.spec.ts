import { Logger } from '@nestjs/common';
import type { OutboundEmail } from './mailer.port';
import { ConsoleMailer, UndeliverableMailer } from './console.mailer';
import type { TenantLinkService } from './tenant-link.service';

const TENANT = '0192f0ff-0000-7000-8000-0000000000c3';

function linksAnswering(link: string | null): TenantLinkService {
  return { absoluteLink: () => Promise.resolve(link) } as unknown as TenantLinkService;
}

const RESET: OutboundEmail = {
  to: 'agent@example.invalid',
  template: 'password_reset',
  tenantId: TENANT,
  data: { linkPath: '/reset-password', token: 'tok3n' },
};

describe('ConsoleMailer', () => {
  it('renders the link so the flow is testable with no vendor account', async () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message) => {
      logged.push(String(message));
    });

    await new ConsoleMailer(
      linksAnswering('http://acme.app.localhost/reset-password#token=tok3n'),
    ).send(RESET);

    expect(logged[0]).toContain('http://acme.app.localhost/reset-password#token=tok3n');
    expect(logged[0]).toContain('agent@example.invalid');
  });

  it('logs a notification with no link for a template that carries none', async () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message) => {
      logged.push(String(message));
    });

    await new ConsoleMailer(linksAnswering('unused')).send({
      to: 'agent@example.invalid',
      template: 'password_changed',
      tenantId: TENANT,
      data: {},
    });

    expect(logged[0]).not.toContain('link=');
  });

  it('warns rather than guessing when the tenant has no verified domain', async () => {
    const warned: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      warned.push(String(message));
    });

    await new ConsoleMailer(linksAnswering(null)).send(RESET);

    expect(warned[0]).toContain('no verified domain');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});

describe('UndeliverableMailer', () => {
  it('drops the message loudly, and never puts the token in the log', async () => {
    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message) => {
      errors.push(String(message));
    });

    await new UndeliverableMailer().send(RESET);

    expect(errors[0]).toContain('password_reset');
    // The whole reason a deployed environment gets this adapter rather than the
    // console one: a reset token in a log aggregator is a disclosed credential.
    expect(errors[0]).not.toContain('tok3n');

    jest.restoreAllMocks();
  });
});
