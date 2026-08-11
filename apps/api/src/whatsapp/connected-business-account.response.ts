import type { ConnectedWhatsAppBusinessAccountResponse } from '@whatsappcrm/contracts';
import type { ConnectBusinessAccountResult } from './business-account-connection.service';

/**
 * The one mapping from a connected WABA onto the published response.
 *
 * Written out field by field rather than spread, so widening the service's
 * projection cannot quietly add a field to the API. This is the mapping the
 * encrypted access token would have to pass through to escape, and it does not
 * appear here.
 *
 * Shared by the operator route and the tenant-facing Embedded Signup route
 * (TAR-168) rather than written twice. Two copies of a projection whose value is
 * *what it leaves out* is one copy too many: a column added to
 * `WABA_PROJECTION` should have exactly one place that decides whether the API
 * publishes it.
 */
export function toConnectedBusinessAccountResponse({
  businessAccount,
}: ConnectBusinessAccountResult): ConnectedWhatsAppBusinessAccountResponse {
  return {
    id: businessAccount.id,
    wabaId: businessAccount.wabaId,
    name: businessAccount.name,
    verificationStatus: businessAccount.verificationStatus,
    createdAt: businessAccount.createdAt.toISOString(),
    updatedAt: businessAccount.updatedAt.toISOString(),
    accounts: businessAccount.accounts.map((account) => ({
      id: account.id,
      whatsappBusinessAccountId: account.whatsappBusinessAccountId,
      phoneNumberId: account.phoneNumberId,
      displayPhoneNumber: account.displayPhoneNumber,
      verifiedName: account.verifiedName,
      qualityRating: account.qualityRating,
      status: account.status,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    })),
  };
}
