import type {
  ConnectedWhatsAppBusinessAccountResponse,
  WhatsAppAccountResponse,
} from '@whatsappcrm/contracts';
import type { StepperStatus } from '@/components/ui/Stepper';
import type { WhatsAppConnectFailureReport } from './connect-failure';

/**
 * The WhatsApp connection, as four steps with a real dependency chain (TAR-814).
 *
 * ## Why a wizard and not one panel
 *
 * Connecting is not one act. Meta's Embedded Signup hands back a business
 * account; a business account holds numbers; a number cannot **send** until Meta
 * registers it; and a number nobody has messaged has never proved it can
 * receive. Rendered as a single panel, the three facts after the first are
 * footnotes under a success message — which is how a workspace ends up with a
 * connected number that silently refuses every send, the failure
 * `WhatsAppRegistrationStatus` exists to make visible.
 *
 * ## Every status is derived, never asserted
 *
 * Nothing here is a checkbox somebody ticks. Each step's status is computed from
 * what the API last answered — the connect response, the registration response,
 * the inbox — on the same reasoning `contracts/onboarding.ts` gives for its own
 * checklist: a step a client could mark done is decoration rather than a
 * description of the workspace.
 *
 * That is also what makes resuming cheap. `WhatsAppWizardProgress` is the whole
 * of the wizard's memory, it is small, and it carries no credential — the
 * contract asserts that neither the WABA access token nor the registration PIN
 * appears in any response schema, so persisting a connect response persists no
 * secret. `wizard-storage.ts` writes it; this file decides what it means.
 */

export const WHATSAPP_WIZARD_STEP_IDS = [
  'connect_account',
  'select_number',
  'register_number',
  'test_send',
] as const;

export type WhatsAppWizardStepId = (typeof WHATSAPP_WIZARD_STEP_IDS)[number];

/**
 * What the wizard remembers between renders, and across a reload.
 *
 * `account` is the connect response verbatim rather than a reduction of it: the
 * numbers table, the verification status and the per-number registration state
 * all render from it, and re-deriving a narrower shape here would mean a second
 * place to update when the contract grows a field.
 */
export interface WhatsAppWizardProgress {
  readonly account: ConnectedWhatsAppBusinessAccountResponse | null;
  /**
   * Our id for the number this workspace will send from — `accounts[].id`, never
   * Meta's `phone_number_id`, because it is what the registration route takes.
   *
   * Null until step 2 settles. A WABA with exactly one number selects it on
   * arrival: offering a choice of one is a question with no answer to give.
   */
  readonly selectedNumberId: string | null;
  /**
   * Whether a message has been seen arriving on the selected number. Set by the
   * inbox check in step 4 and remembered, so a reload does not send somebody
   * back to their phone to prove the same thing twice.
   */
  readonly hasInbound: boolean;
}

export const EMPTY_WHATSAPP_WIZARD_PROGRESS: WhatsAppWizardProgress = {
  account: null,
  selectedNumberId: null,
  hasInbound: false,
};

/**
 * A step that ended badly, and which one.
 *
 * Held apart from `WhatsAppWizardProgress` and deliberately not persisted: a
 * failure describes an attempt, not the workspace, and a reload that restored
 * "Meta is rate-limiting us" from ten minutes ago would be reporting a condition
 * nobody has re-tested.
 */
export type WhatsAppWizardFailure =
  | { readonly step: 'connect_account'; readonly report: WhatsAppConnectFailureReport }
  | { readonly step: 'register_number' }
  | { readonly step: 'test_send' };

/**
 * The two ways step 2 can have nothing usable to offer. Both come out of the
 * connect response rather than out of a request of our own, which is why they
 * are a shape here and not a failure report.
 */
export type WhatsAppNumberProblem = 'no_numbers' | 'number_unusable';

/** The selected number, or null while step 2 has not settled. */
export function selectedWhatsAppNumber(
  progress: WhatsAppWizardProgress,
): WhatsAppAccountResponse | null {
  if (progress.account === null || progress.selectedNumberId === null) {
    return null;
  }

  return (
    progress.account.accounts.find((number) => number.id === progress.selectedNumberId) ?? null
  );
}

/**
 * Which number a fresh connect response should open on. Exactly one number is
 * chosen for the reader; anything else is a question only they can answer.
 */
export function autoSelectedWhatsAppNumberId(
  account: ConnectedWhatsAppBusinessAccountResponse,
): string | null {
  return account.accounts.length === 1 ? (account.accounts[0]?.id ?? null) : null;
}

/**
 * Whether step 2 has a problem to report rather than a choice to offer.
 *
 * `disconnected` is not one: Meta reports it for a number that is attached and
 * currently unreachable, which is a thing to say on the row and not a reason to
 * refuse the selection.
 */
export function whatsAppNumberProblem(
  progress: WhatsAppWizardProgress,
): WhatsAppNumberProblem | null {
  if (progress.account === null) {
    return null;
  }

  if (progress.account.accounts.length === 0) {
    return 'no_numbers';
  }

  return selectedWhatsAppNumber(progress)?.status === 'error' ? 'number_unusable' : null;
}

/**
 * Each step's status, in one pass over what is known.
 *
 * The four values are `Stepper`'s, so a status here is drawn the same way it
 * would be in any other stepped flow. `error` is only ever reported for a step
 * the reader has actually reached — a failure recorded against step 3 while step
 * 2 is still open would draw a red marker beside work nobody has started.
 */
export function whatsAppWizardStatuses(
  progress: WhatsAppWizardProgress,
  failure: WhatsAppWizardFailure | null,
): Record<WhatsAppWizardStepId, StepperStatus> {
  const number = selectedWhatsAppNumber(progress);
  const problem = whatsAppNumberProblem(progress);

  const connect: StepperStatus =
    failure?.step === 'connect_account' ? 'error' : progress.account === null ? 'current' : 'done';

  const select: StepperStatus =
    connect !== 'done'
      ? 'upcoming'
      : problem !== null
        ? 'error'
        : number === null
          ? 'current'
          : 'done';

  const register: StepperStatus =
    select !== 'done'
      ? 'upcoming'
      : number?.registrationStatus === 'registered'
        ? 'done'
        : number?.registrationStatus === 'failed' || failure?.step === 'register_number'
          ? 'error'
          : 'current';

  const test: StepperStatus =
    register !== 'done'
      ? 'upcoming'
      : progress.hasInbound
        ? 'done'
        : failure?.step === 'test_send'
          ? 'error'
          : 'current';

  return {
    connect_account: connect,
    select_number: select,
    register_number: register,
    test_send: test,
  };
}

/** How many steps are behind the reader. Drives the progress meter. */
export function whatsAppWizardResolvedCount(
  statuses: Record<WhatsAppWizardStepId, StepperStatus>,
): number {
  return WHATSAPP_WIZARD_STEP_IDS.filter((id) => statuses[id] === 'done').length;
}

/** True once every step is behind the reader — the flow has nothing left to ask. */
export function isWhatsAppWizardComplete(
  statuses: Record<WhatsAppWizardStepId, StepperStatus>,
): boolean {
  return whatsAppWizardResolvedCount(statuses) === WHATSAPP_WIZARD_STEP_IDS.length;
}

/**
 * Folds a fresh registration answer back into the remembered account.
 *
 * The registration route answers with the number's four registration fields and
 * not with the whole account, so this is the one place the two shapes meet.
 * Returns the input unchanged when the id names nothing — a response for a
 * number the wizard is not holding is not something to merge on a guess.
 */
export function withWhatsAppRegistration(
  progress: WhatsAppWizardProgress,
  registration: Pick<
    WhatsAppAccountResponse,
    | 'id'
    | 'registrationStatus'
    | 'registrationFailureReason'
    | 'registeredAt'
    | 'registrationAttemptedAt'
  >,
): WhatsAppWizardProgress {
  if (progress.account === null) {
    return progress;
  }

  const accounts = progress.account.accounts.map((number) =>
    number.id === registration.id
      ? {
          ...number,
          registrationStatus: registration.registrationStatus,
          registrationFailureReason: registration.registrationFailureReason,
          registeredAt: registration.registeredAt,
          registrationAttemptedAt: registration.registrationAttemptedAt,
        }
      : number,
  );

  return { ...progress, account: { ...progress.account, accounts } };
}
