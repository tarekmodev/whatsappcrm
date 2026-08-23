/**
 * The contract types `en.ts` keys its lookup tables on.
 *
 * Re-exported through this one module rather than imported directly by the copy
 * file, so a `satisfies Record<…>` there reads as a list of names rather than as
 * a paragraph of imports — and so the day one of these moves in the contracts
 * package, one file changes.
 */
export type {
  LifecycleActorType,
  LifecycleTrigger,
  TenantStatus,
  WebhookEventStatus,
} from '@whatsappcrm/contracts';

export type { DeploymentEnvironment } from '~/lib/admin-env';
