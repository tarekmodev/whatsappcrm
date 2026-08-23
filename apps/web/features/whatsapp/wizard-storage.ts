import { ConnectedWhatsAppBusinessAccountResponseSchema } from '@whatsappcrm/contracts';
import { EMPTY_WHATSAPP_WIZARD_PROGRESS, type WhatsAppWizardProgress } from './wizard';

/**
 * Where the connect wizard's progress survives a reload (TAR-814).
 *
 * ## Why this is client storage and not a read
 *
 * TAR-814 asks for a wizard somebody can come back to. Every other resume in
 * this console is a server read — the onboarding checklist derives its steps
 * from the tenant's actual state — and that is what belongs here too. It cannot
 * be done yet: the API publishes `POST /v1/whatsapp/business-accounts` and **no
 * tenant-facing `GET`**, a gap `lib/api/whatsapp.ts` and `WhatsAppSections` have
 * both been carrying a note about since TAR-169. Until one exists the console can
 * show what a connection just produced and cannot ask what was connected
 * yesterday, and TAR-814's own acceptance criteria rule out adding the endpoint
 * here.
 *
 * So this is a **cache of the last answer, not an authority**, and it is written
 * to say so: the wizard labels a restored connection as remembered, and every
 * step keeps its action so live truth is one press away.
 *
 * ## `sessionStorage`, and what that decides
 *
 * Per tab, cleared when the tab closes. A shared workstation is the case that
 * rules out `localStorage`: this holds a business name, a WABA id and a phone
 * number — no credential, which the contract asserts and `contract.test.ts`
 * enforces, but tenant data all the same, and it should not outlive the sitting.
 * The origin is the tenant (the console is host-per-tenant), so cross-tenant
 * isolation comes from the browser rather than from a key we have to remember to
 * scope.
 *
 * ## Nothing is trusted on the way back in
 *
 * A value read here has been outside the type system: a stale build wrote it, a
 * devtools console edited it, a later contract renamed a field. It is parsed
 * with the contract's own schema — the same object the API validates its
 * response with — and anything that fails is discarded rather than repaired.
 * Zod strips unknown keys, so a payload that has grown a field cannot smuggle
 * one through either.
 */

const STORAGE_KEY = 'whatsappcrm.whatsapp-wizard';

/**
 * The wizard's memory, as JSON. Kept apart from `WhatsAppWizardProgress` because
 * the two are allowed to diverge: this shape is a **stored format** with a
 * version on it, and the type above is what the running code holds.
 */
const STORAGE_VERSION = 1;

export function readWhatsAppWizardProgress(): WhatsAppWizardProgress {
  const raw = storage()?.getItem(STORAGE_KEY);

  if (raw === null || raw === undefined) {
    return EMPTY_WHATSAPP_WIZARD_PROGRESS;
  }

  try {
    return parseStored(JSON.parse(raw));
  } catch {
    // Not JSON at all, or JSON this build cannot make sense of. Starting the
    // wizard from the top is recoverable; rendering half a restored connection
    // is not, and neither is throwing inside a mount effect.
    clearWhatsAppWizardProgress();

    return EMPTY_WHATSAPP_WIZARD_PROGRESS;
  }
}

export function writeWhatsAppWizardProgress(progress: WhatsAppWizardProgress): void {
  if (progress.account === null) {
    // Nothing worth remembering: the flow has not started, or it was reset.
    clearWhatsAppWizardProgress();

    return;
  }

  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...progress }));
  } catch {
    // A full quota, or storage denied by a privacy setting. The wizard works
    // for this sitting and will not resume after a reload — which is a
    // degradation, not a failure, and not worth interrupting anybody over.
  }
}

export function clearWhatsAppWizardProgress(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // As above: a browser that refuses to forget is not something to report.
  }
}

/**
 * `sessionStorage` where there is one.
 *
 * Absent during a server render, and absent in a browser where storage is
 * denied outright — Safari's private mode has historically thrown on the
 * *property access*, not only on the call, which is why this is a `try` rather
 * than a `typeof window` check.
 */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The stored shape, validated field by field.
 *
 * The account goes through the contract's own schema. The two scalars beside it
 * are checked here because they are the wizard's, not the API's — and
 * `selectedNumberId` is additionally required to *name a number on the account
 * that was stored*, so a payload cannot restore a selection pointing at nothing.
 */
function parseStored(value: unknown): WhatsAppWizardProgress {
  if (typeof value !== 'object' || value === null) {
    return EMPTY_WHATSAPP_WIZARD_PROGRESS;
  }

  const stored = value as Record<string, unknown>;

  if (stored.version !== STORAGE_VERSION) {
    // Written by a build that shaped this differently. Discarded rather than
    // migrated: the flow is four presses, and a wrong migration is worse.
    return EMPTY_WHATSAPP_WIZARD_PROGRESS;
  }

  const account = ConnectedWhatsAppBusinessAccountResponseSchema.safeParse(stored.account);

  if (!account.success) {
    return EMPTY_WHATSAPP_WIZARD_PROGRESS;
  }

  const selectedNumberId =
    typeof stored.selectedNumberId === 'string' &&
    account.data.accounts.some((number) => number.id === stored.selectedNumberId)
      ? stored.selectedNumberId
      : null;

  return {
    account: account.data,
    selectedNumberId,
    // A remembered inbound is only meaningful about a remembered number.
    hasInbound: selectedNumberId !== null && stored.hasInbound === true,
  };
}
