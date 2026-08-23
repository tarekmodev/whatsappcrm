import type { TenantRole } from '@whatsappcrm/contracts';

/**
 * Typed failures the people services raise, mapped to error codes by the
 * controllers.
 *
 * Domain errors rather than `ApiException`s thrown from the service layer: the
 * services are also driven by TAR-36's graduation flow and by fixtures, neither
 * of which has an HTTP response to put a status on. The controller owns the
 * translation, which keeps the status mapping in one readable place per resource.
 */

export class UserNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`No user ${userId} in this tenant.`);
    this.name = 'UserNotFoundError';
  }
}

export class TeamNotFoundError extends Error {
  constructor(readonly teamId: string) {
    super(`No team ${teamId} in this tenant.`);
    this.name = 'TeamNotFoundError';
  }
}

/** A `teamIds`/`memberUserIds` entry naming something that is not in this tenant. */
export class UnknownReferenceError extends Error {
  constructor(
    kind: 'team' | 'user',
    readonly ids: readonly string[],
  ) {
    super(`Unknown ${kind}: ${ids.join(', ')}.`);
    this.name = 'UnknownReferenceError';
  }
}

export class EmailAlreadyRegisteredError extends Error {
  constructor(readonly email: string) {
    super(`${email} already has an account in this tenant.`);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export class TeamNameTakenError extends Error {
  constructor(readonly teamName: string) {
    // Names are compared case-insensitively (`citext`), which is worth saying:
    // "Billing already exists" is confusing when you typed "billing".
    super(
      `A team named ${teamName} already exists in this tenant. Team names are case-insensitive.`,
    );
    this.name = 'TeamNameTakenError';
  }
}

/** Invariant 1: no principal changes their own role, including an admin. */
export class SelfRoleChangeError extends Error {
  constructor() {
    super('You cannot change your own role. Ask another admin to do it.');
    this.name = 'SelfRoleChangeError';
  }
}

/**
 * Delta 1: the caller may administer people but may not assign roles. Distinct
 * from `RoleEscalationError` so the message says the true reason — a supervisor
 * refused a *sideways* role assignment is not escalating anything.
 */
export class RoleAssignmentNotPermittedError extends Error {
  constructor(readonly attempted: TenantRole) {
    super(
      `Assigning the ${attempted} role requires the user:set_role permission, which is held by ` +
        'admins only. You can invite an agent, and change a person’s name, status and teams.',
    );
    this.name = 'RoleAssignmentNotPermittedError';
  }
}

/**
 * The caller may administer this person but may not decide how much work
 * reaches them (TAR-384, 0008 decision 4).
 *
 * `assignment_rule:write` rather than `user:update`, and refused rather than
 * quietly dropped: setting a colleague's cap to 1 stops work reaching them, and
 * a privilege-shaped change that appears to have succeeded is the worse of the
 * two failures — the rule TAR-79 established for `role`.
 */
export class CapacityChangeNotPermittedError extends Error {
  constructor() {
    super(
      'Changing an agent’s maximum concurrent tickets requires the assignment_rule:write ' +
        'permission, which is held by supervisors and admins. You can change this person’s ' +
        'name, status and teams.',
    );
    this.name = 'CapacityChangeNotPermittedError';
  }
}

/** Invariant 2: no principal grants a role above their own. */
export class RoleEscalationError extends Error {
  constructor(
    readonly granted: TenantRole,
    readonly callerRole: TenantRole,
  ) {
    super(`You cannot grant the ${granted} role, which is above your own (${callerRole}).`);
    this.name = 'RoleEscalationError';
  }
}

/** Invariant 3: the last active admin cannot be demoted, suspended or removed. */
export class LastAdminRequiredError extends Error {
  constructor() {
    super(
      'This is the last active admin in the tenant. Promote another admin first — a tenant ' +
        'with no admin cannot manage billing, branding or its WhatsApp credentials.',
    );
    this.name = 'LastAdminRequiredError';
  }
}

/**
 * Invariant 4, the half that cannot be repaired automatically: the user is
 * referenced by history — messages they sent, notes they wrote, audited actions
 * they took — which deletion would destroy.
 */
export class UserHasHistoryError extends Error {
  constructor(readonly userId: string) {
    super(
      'This user has conversation or audit history that deleting them would destroy. ' +
        'Suspend them instead — it revokes access immediately and is reversible.',
    );
    this.name = 'UserHasHistoryError';
  }
}
