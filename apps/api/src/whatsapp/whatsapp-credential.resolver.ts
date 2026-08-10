import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { WhatsAppAccessTokenCipher } from './access-token.cipher';
import {
  WhatsAppAccountNotFoundError,
  WhatsAppBusinessAccountNotFoundError,
  WhatsAppCredentialMissingError,
} from './whatsapp.errors';

/**
 * The only three columns any credential lookup reads. Named once so the
 * encrypted token has exactly one projection in the codebase — widening a
 * `select` elsewhere cannot pull it into a query that was not meant to have it.
 */
const WABA_CREDENTIAL_PROJECTION = {
  id: true,
  wabaId: true,
  accessTokenEncrypted: true,
} as const;

/** What a Graph API call needs to act as one business account. */
export interface BusinessAccountCredentials {
  /** Our id for the WABA row. */
  whatsappBusinessAccountId: string;
  /** Meta's id for the business account, and the path segment template calls use. */
  wabaId: string;
  accessToken: string;
}

/** What a send needs: the number to send from, and the business account's token. */
export interface PhoneNumberCredentials extends BusinessAccountCredentials {
  whatsappAccountId: string;
  /** Meta's id for the number, and the path segment message sends use. */
  phoneNumberId: string;
}

/**
 * The single place a stored access token is decrypted (TAR-39, security:
 * "decrypted only in the send path").
 *
 * Concentrating it here is the whole point. A token decrypted in three services
 * is a token in three stack traces, three log statements away from an incident,
 * and three places to audit when the key rotates. Every caller that needs to
 * talk to Meta asks this resolver, uses the credential for one call, and lets it
 * go out of scope.
 *
 * ## Isolation
 *
 * Every read goes through `TenantPrisma`, so TAR-48's `tenant_isolation` policy
 * supplies `tenant_id` on the query and a WABA belonging to another tenant is
 * indistinguishable from one that does not exist — which is what
 * `WhatsAppBusinessAccountNotFoundError` says, and why it does not say
 * "forbidden" (TAR-39, security: a 403 confirms the id exists).
 */
@Injectable()
export class WhatsAppCredentialResolver {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly cipher: WhatsAppAccessTokenCipher,
  ) {}

  /** By our own id for the WABA row — what an internal caller holding a foreign key has. */
  async forBusinessAccount(whatsappBusinessAccountId: string): Promise<BusinessAccountCredentials> {
    const waba = await this.prisma.whatsappBusinessAccount.findUnique({
      where: { id: whatsappBusinessAccountId },
      select: WABA_CREDENTIAL_PROJECTION,
    });

    if (waba === null) {
      throw new WhatsAppBusinessAccountNotFoundError(whatsappBusinessAccountId);
    }

    return this.decrypt(waba);
  }

  /**
   * By Meta's id — what an operator has in front of them, and what an admin
   * route therefore takes in its path.
   *
   * `waba_id` is unique globally, but this read still goes through
   * `TenantPrisma`: a WABA connected to another tenant must come back as absent,
   * not as forbidden, or the endpoint becomes a way to test which Meta business
   * accounts the platform holds (TAR-39, security).
   */
  async forBusinessAccountByWabaId(wabaId: string): Promise<BusinessAccountCredentials> {
    const waba = await this.prisma.whatsappBusinessAccount.findUnique({
      where: { wabaId },
      select: WABA_CREDENTIAL_PROJECTION,
    });

    if (waba === null) {
      throw new WhatsAppBusinessAccountNotFoundError(wabaId);
    }

    return this.decrypt(waba);
  }

  /**
   * By the number's own id — what a send has, because a conversation names a
   * number and the number names exactly one WABA.
   *
   * One query, not two: the token lives on the parent, and fetching the number
   * and then its business account would be an N+1 the moment a batch of queued
   * sends went through it.
   */
  async forPhoneNumber(whatsappAccountId: string): Promise<PhoneNumberCredentials> {
    const account = await this.prisma.whatsappAccount.findUnique({
      where: { id: whatsappAccountId },
      select: {
        id: true,
        phoneNumberId: true,
        whatsappBusinessAccount: { select: WABA_CREDENTIAL_PROJECTION },
      },
    });

    if (account === null) {
      throw new WhatsAppAccountNotFoundError(whatsappAccountId);
    }

    return {
      ...this.decrypt(account.whatsappBusinessAccount),
      whatsappAccountId: account.id,
      phoneNumberId: account.phoneNumberId,
    };
  }

  /**
   * `wabaId` is passed as the cipher's additional authenticated data as well as
   * being the value returned, which is what binds a ciphertext to the row it was
   * written for: a payload copied into another WABA's row fails to decrypt
   * rather than authorising sends as a business it was never issued for.
   */
  private decrypt(waba: {
    id: string;
    wabaId: string;
    accessTokenEncrypted: string | null;
  }): BusinessAccountCredentials {
    if (waba.accessTokenEncrypted === null) {
      throw new WhatsAppCredentialMissingError(waba.wabaId);
    }

    return {
      whatsappBusinessAccountId: waba.id,
      wabaId: waba.wabaId,
      accessToken: this.cipher.decrypt(waba.accessTokenEncrypted, waba.wabaId),
    };
  }
}
