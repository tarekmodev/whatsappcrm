# RBAC permission matrix — agent, supervisor, admin (TAR-79)

Status: **confirmed**, with three deltas to land in TAR-81.
Confirms and amends: [0002 — architecture and API contract](./0002-architecture-and-api-contract.md).
Consumed by: TAR-80 (schema), TAR-81 (backend), TAR-82 (frontend), TAR-83 (QA), TAR-84 (review).

## Context and Problem

TAR-39 did not leave the permission model undefined. It shipped a role vocabulary and a
role→permission table in `packages/contracts/src/rbac.ts`, a `SessionPrincipal` shape in
`auth.ts`, and a `PermissionGuard` slot in the request pipeline. So this note is a
**confirmation, not an invention**: the job is to check that table against TAR-22's three
acceptance criteria and TAR-39's tenant-scoping and session conventions, and to close what
it leaves open.

Two things make that non-trivial.

**Downstream has already run ahead of this gate.** TAR-80 (schema) and TAR-82 (console UI)
are both in review, built against the table as it stands today. A matrix that contradicted
them would be churn, not architecture. So below, every row that is already right is marked
confirmed and left alone, and the deltas are named precisely — three of them, all confined
to one contract file plus guard logic. **No schema change is required**: TAR-80 can merge as
reviewed.

**The gaps that remain are not cosmetic.** One is a privilege-escalation path that is live
in the contract today: `user:invite` is granted to supervisors and
`InviteCreateInputSchema.role` accepts any `TenantRole`, so a supervisor can mint an admin.

## Goals / Non-Goals

**Goals**

- A normative role→permission matrix for `agent` / `supervisor` / `admin`, tenant-scoped.
- One canonical **visibility predicate** for own-vs-team-vs-tenant record access, written
  once and reused by conversations, tickets and reporting.
- Confirmation of the role-claim shape and how role is carried on the session.
- The **interim role source** for the window before TAR-35 lands, specified for both halves
  (frontend has already shipped its half; the API half is unwritten).
- The invariants that protect role writes: escalation, self-modification, admin lockout.

**Non-Goals**

- Tenant-configurable or custom roles. Three roles cover v1 (TAR-22's stated assumption).
  The table is a constant; making it rows is a later, additive change that touches only
  `rbac.ts` because guards already ask for permissions.
- Cross-tenant / platform super-admin. Explicitly out of scope in TAR-22.
- Per-record ACLs or sharing. Visibility is derived from assignment and team membership.
- Implementing any of this. TAR-81 owns the guard, TAR-35 owns the session.

## Confirmed against TAR-39's conventions

### Role-claim shape — confirmed, no change

The role claim is `SessionPrincipal` in `packages/contracts/src/auth.ts`, resolved once per
request and published on `TenantContextService`:

```ts
{ userId, tenantId, email, displayName,
  role: TenantRole,              // 'agent' | 'supervisor' | 'admin'
  permissions: Permission[],     // materialised from role, never hand-assembled
  teamIds: Id[],                 // the team half of the visibility predicate
  sessionId, expiresAt }
```

Four rules that come with it, all of which the shipped code already follows:

1. **Guards check permissions, never roles.** `@RequirePermission('user:update')`, never
   `if (role === 'admin')`. `ROLE_PERMISSIONS` in `rbac.ts` is the only place in the system
   where a role is interpreted.
2. **`permissions` is materialised through `permissionsForRole(role)`** at principal
   resolution. Never written out by hand, in production or in a stub. TAR-82's
   `buildStubPrincipal` does this correctly and is the reference implementation.
3. **`teamIds` is a snapshot**, filled from `team_members` at resolution. It is authoritative
   for the request and stale the moment membership changes — see the eviction rule below.
4. **No role widens tenant scope.** `PermissionGuard` is pipeline slot 5, after
   `AuthGuard` has called `setTenant()`; every query then runs through `TenantPrisma` under
   RLS. The matrix governs what a principal may do _inside_ its tenant and has no
   cross-tenant row by construction — an `admin` is a tenant admin, and there is no
   permission that reaches another tenant's data. That is the answer to "validated against
   tenant scoping": the two mechanisms are orthogonal and composed, not alternatives, and
   the matrix cannot be the thing that leaks a tenant.

### Amendment to TAR-39, Decision 2 — role changes must revoke sessions

TAR-39 chose opaque server-side sessions over JWTs on the stated grounds that "TAR-18
requires session revocation and role changes that take effect immediately; both are free
here." The failure-mode table then caches the principal in Redis with a TTL of ≤60s and
notes "a stale cached principal outlives a role change." Those two statements contradict
each other, and the cache wins: a demotion would leave up to 60 seconds of elevated access.

**Rule.** Any write that changes `users.role`, `users.status`, or a user's team membership
must, in the same transaction as the write:

1. delete the target user's `sessions` rows, and
2. evict that user's cached principal.

Cost is one extra delete on an operation that happens a few times a month per tenant. What
it buys is that the promise TAR-39 made is actually true — a demoted supervisor is logged
out, not merely eventually downgraded. A role change is therefore a forced re-login, which
is also the correct user-visible behaviour: the console's navigation is computed from the
principal at render time and would otherwise be wrong until refresh.

The `permissions` array on the principal is what makes this safe to reason about: it is
computed at login, so nothing needs to re-derive it, and killing the session is the _only_
invalidation path. There is no second cache to reason about.

## The matrix

`agent` ⊂ `supervisor` ⊂ `admin` — strictly nested, and `admin` is defined as the whole
`PERMISSIONS` set. Nesting is a deliberate simplification: it means a supervisor can always
do an agent's job (they cover shifts), and it makes the table auditable at a glance.

Legend: ✅ granted · — not granted · **Δ** a delta from the table shipped in TAR-39.

### Conversations and tickets — TAR-22 AC1, AC2

| Permission              | agent | supervisor | admin | Notes                                                      |
| ----------------------- | :---: | :--------: | :---: | ---------------------------------------------------------- |
| `conversation:read`     |  ✅   |     ✅     |  ✅   | Scoped by the predicate below                              |
| `conversation:read_all` |   —   |     ✅     |  ✅   | Tenant-wide; the agent/supervisor line                     |
| `conversation:send`     |  ✅   |     ✅     |  ✅   | Only on a visible conversation                             |
| `conversation:note`     |  ✅   |     ✅     |  ✅   | Internal notes                                             |
| `conversation:claim`    |  ✅   |     ✅     |  ✅   | **Δ** Take a thread nobody is on; never one somebody holds |
| `conversation:assign`   |   —   |     ✅     |  ✅   | Route to a team, release, and re-assign away from oneself  |
| `ticket:read`           |  ✅   |     ✅     |  ✅   | Same predicate                                             |
| `ticket:read_all`       |   —   |     ✅     |  ✅   |                                                            |
| `ticket:update`         |  ✅   |     ✅     |  ✅   | Status, priority on a visible ticket                       |
| `ticket:close`          |  ✅   |     ✅     |  ✅   |                                                            |
| `ticket:assign`         |   —   |     ✅     |  ✅   |                                                            |

### Contacts — TAR-33

| Permission       | agent | supervisor | admin | Notes                                  |
| ---------------- | :---: | :--------: | :---: | -------------------------------------- |
| `contact:read`   |  ✅   |     ✅     |  ✅   | Tenant-wide: a contact is not assigned |
| `contact:write`  |  ✅   |     ✅     |  ✅   | Agents correct customer details daily  |
| `contact:delete` |   —   |     —      |  ✅   | Destructive and GDPR-adjacent          |

Contacts are deliberately **not** subject to the visibility predicate. A contact has no
assignee, and an agent who can read a conversation must be able to read the person on the
other end of it. Deletion is admin-only because it is a data-subject operation.

### People and teams — TAR-22 AC3

| Permission      | agent | supervisor |  admin   | Notes                                        |
| --------------- | :---: | :--------: | :------: | -------------------------------------------- |
| `user:read`     |  ✅   |     ✅     |    ✅    | Directory; needed to render assignee names   |
| `user:invite`   |   —   |     ✅     |    ✅    | Role assignable is bounded — see Delta 1     |
| `user:update`   |   —   |  **Δ** ✅  |    ✅    | Name, status, team membership — **not** role |
| `user:set_role` |   —   |     —      | **Δ** ✅ | New permission — see Delta 1                 |
| `user:remove`   |   —   |     —      |    ✅    | Suspension covers the supervisor's need      |
| `team:read`     |  ✅   |     ✅     |    ✅    |                                              |
| `team:write`    |   —   |     ✅     |    ✅    | Create, rename, membership                   |

`PATCH /users/me/availability` carries no permission: any authenticated principal sets
their own availability. That is already how the endpoint surface is written.

### Routing, SLA and automation

| Permission               | agent | supervisor | admin | Notes                                |
| ------------------------ | :---: | :--------: | :---: | ------------------------------------ |
| `assignment_rule:read`   |   —   |     ✅     |  ✅   | TAR-22 AC3 "assignment settings"     |
| `assignment_rule:write`  |   —   |     ✅     |  ✅   | TAR-23/24                            |
| `sla:read` / `sla:write` |   —   |     ✅     |  ✅   | TAR-26                               |
| `canned_response:read`   |  ✅   |     ✅     |  ✅   | TAR-31                               |
| `canned_response:write`  |   —   |     ✅     |  ✅   | Curated, not crowd-sourced           |
| `workflow:read/write`    |   —   |     ✅     |  ✅   | TAR-27 — amended, see below          |
| `workflow:send_message`  |   —   |     —      |  ✅   | Reserved. No action carries it at v1 |
| `ai:read` / `ai:write`   |   —   |     —      |  ✅   | TAR-28 — same reasoning              |

The AI chatbot is admin-only because it acts on a customer conversation without a human
in the loop. A misconfigured chatbot is a mass-messaging incident, and that is not a
supervisor-shift-level decision.

**⚠️ Amended by TAR-392.** `workflow:read` / `workflow:write` were admin-only here for the
same reason, and TAR-27's user story opens "As a supervisor". The reason does not survive
contact with the action set TAR-27 actually ships:
[0009 decision on access](./0009-workflow-triggers-conditions-actions.md#the-permission-question-0004-leaves-open)
grants both to supervisor, because `tag`, `reassign`, `notify` and `change status/priority`
are every one of them something a supervisor can already do by hand with `ticket:update`,
`ticket:assign` and `ticket:read_all`, on tickets they can already see. Automating them
changes the speed, not the blast radius.

The risk this paragraph names is real and moves rather than disappears: the mass-messaging
incident needs an action that reaches a customer. `workflow:send_message` is reserved for
the first such action, stays admin-only, and is checked **at workflow-write time on the
action type** — a workflow runs with no principal, so there is nobody to check when it
fires. A supervisor holding `workflow:write` alone may use every action published in
`WORKFLOW_ACTION_TYPES` and none added later carrying that flag.

### Reporting — TAR-22 AC3, TAR-30

| Permission        | agent | supervisor | admin | Notes                               |
| ----------------- | :---: | :--------: | :---: | ----------------------------------- |
| `report:read`     |  ✅   |     ✅     |  ✅   | Aggregates over **visible** records |
| `report:read_all` |   —   |     ✅     |  ✅   | Tenant-wide                         |

### Tenant administration

| Permission        | agent | supervisor | admin | Notes                                        |
| ----------------- | :---: | :--------: | :---: | -------------------------------------------- |
| `tenant:settings` |   —   |     —      |  ✅   | TAR-22 AC1: agents see no admin settings     |
| `branding:write`  |   —   |     —      |  ✅   | TAR-29                                       |
| `channel:manage`  |   —   |     —      |  ✅   | WABA + phone numbers; holds Meta credentials |
| `billing:read`    |   —   |     —      |  ✅   | TAR-37                                       |
| `billing:manage`  |   —   |     —      |  ✅   |                                              |

This block is what satisfies TAR-22 AC1's "not tenant admin settings" — an agent holds none
of it, and the console computes its navigation from the same permission set, so there is no
reachable route.

## The visibility predicate

The single most re-implementable rule in this story, so it is written once here and must be
imported, not re-typed. It applies unchanged to `conversations` (TAR-20), `tickets` (TAR-21)
and any future assignable record.

```ts
// Pseudocode; TAR-81 lands the real signature in RbacModule.
function visible(
  record: { assignedUserId: Id | null; assignedTeamId: Id | null },
  principal: SessionPrincipal,
  readAll: Permission,
): boolean {
  if (principal.permissions.includes(readAll)) return true; // supervisor, admin
  if (record.assignedUserId === principal.userId) return true; // mine
  return (
    record.assignedTeamId !== null && // my team's
    principal.teamIds.includes(record.assignedTeamId)
  );
}
```

Five consequences, each of which has already caught something:

1. **`scope=assigned` means "mine ∪ my teams'", not "assigned to me".** The name reads
   narrower than the behaviour, which is exactly why it is stated here. TAR-82's mock
   transport already implements it this way and is correct; TAR-81 must match it, because
   TAR-22 AC2 ("conversations routed to a team are visible to its members") is unsatisfiable
   otherwise — an agent has no other route to a team-routed conversation.
2. **Narrow, never reject.** A caller without `_all` who requests `scope=all` gets
   `assigned` silently, per `ConversationListQuerySchema`. A supervisor's shared inbox URL
   renders for an agent with less in it, rather than erroring. The console shows a notice
   saying so — that notice is what stops it reading as data loss.
3. **`scope=unassigned` requires `_all` for tickets.** An agent cannot browse and self-serve
   an unclaimed ticket; it reaches them through assignment (TAR-23/24) or a supervisor,
   because that backlog is work somebody has already triaged and widening it would expose
   the whole tenant's. **Conversations are the exception**, ruled by 0002 amendment 4: a
   conversation is created by a customer writing in, so an unclaimed one is by construction
   visible to nobody, and `scope=unassigned` is open to every role. TAR-186 completed that
   with the `conversation:claim` this item used to propose — see invariant 8.
4. **Reporting uses the same predicate.** `report:read` aggregates over exactly
   `visible(...)`; `report:read_all` is tenant-wide. If a report ever computed over a wider
   set than the list endpoint, reporting would become a read channel around the matrix —
   an agent inferring another team's volumes from a dashboard they can legitimately open.
5. **Query shape needs measuring, not assuming.** TAR-80 landed two matching indexes
   (`conversations_tenant_assigned_user_inbox_idx` and `…_team_inbox_idx`), each carrying
   the keyset sort key. The predicate is an OR across both, and an `OR` in a `WHERE` beside
   an `ORDER BY … LIMIT` is exactly the shape a planner can answer with the tenant-wide
   index plus a filter instead. **Needs verification in TAR-81** with `EXPLAIN (ANALYZE,
BUFFERS)`: if the OR form does not use both indexes, switch to a `UNION ALL` of two
   keyset pages merged in the API. No benchmark is claimed here.
6. **Visible is not writable, for conversations** (TAR-186, 0002 amendment 6). An unclaimed
   conversation is readable by every role and writable by none: the send, the internal note
   and the status change refuse it with `conflict` until somebody holds it. Without this,
   the widening in invariant 3 means two agents both reply to the same arriving customer,
   and no idempotency key can catch it — each of them sends a distinct request.
7. **`conversation:claim` takes what nobody is on; `conversation:assign` moves what somebody
   is.** The claim is granted to every role and is a compare-and-set bounded to
   `assigned_user_id IS NULL`, so it cannot take a thread off a colleague however it is
   called; a conversation routed to a team may be claimed by a member, and the team
   assignment survives. `conversation:assign` stays supervisor and above and keeps routing,
   release and hand-over — including the deliberately blind write that a take-over is.
8. **Open item 2 is resolved.** "Agents cannot pull unclaimed work at v1" is closed by
   invariant 7, bounded exactly as this document proposed: the caller's teams' unassigned
   records, with the team bound coming from the visibility check rather than from widening
   `unassigned`.

## Delta 1 — split role assignment out of user administration

**The problem is live today.** `SUPERVISOR_PERMISSIONS` includes `user:invite`, and
`InviteCreateInputSchema.role` is an unconstrained `TenantRoleSchema`. A supervisor can
therefore invite a user with `role: 'admin'`, accept nothing, and have that account
administer billing, branding and the WhatsApp credentials. If `user:update` were also
granted to supervisors without this split, they could promote themselves directly.

**Chosen — add a distinct `user:set_role` permission, granted to `admin` only.**

```ts
// packages/contracts/src/rbac.ts
export const PERMISSIONS = [
  …
  'user:read', 'user:invite', 'user:update',
  'user:set_role',            // NEW — admin only
  'user:remove',
  …
];

const SUPERVISOR_PERMISSIONS = [
  ...AGENT_PERMISSIONS,
  …
  'user:invite',
  'user:update',              // NEW — Delta 2
] as const satisfies readonly Permission[];
```

Enforcement, in TAR-81:

- `PATCH /users/{id}` requires `user:update`. If the body carries `role`, it _additionally_
  requires `user:set_role`; absent it, `forbidden`. Not "silently ignore the field" — a
  dropped privilege change that appears to succeed is worse than a refusal.
- `POST /users/invites` requires `user:invite`, and the `role` in the body must be one the
  caller may assign: any role if they hold `user:set_role`, otherwise `agent` only.
- `admin` receives `user:set_role` automatically, because `ROLE_PERMISSIONS.admin` is
  `PERMISSIONS`.

**Rejected — clamp the assignable role inside the users service.** Cheaper: no vocabulary
change, one `if` in one service. Rejected because it puts a role interpretation
(`if (caller.role !== 'admin')`) outside `ROLE_PERMISSIONS`, which is the one thing
`rbac.ts` documents as forbidden — and it is invisible to the console, which would have to
hardcode the same rule to know whether to render the role dropdown. As a permission, the UI
gets it for free from `principal.permissions`.

## Delta 2 — supervisors get `user:update`, not `user:remove`

TAR-22 AC3 requires a supervisor to "see and manage all agents/teams in their tenant". The
shipped table grants `user:invite` and `team:write` but not `user:update`, which is
incoherent: a supervisor can add an agent to a team by editing the team, but not by editing
the agent, and cannot suspend a departing contractor at all.

**Chosen — grant `user:update`; keep `user:remove` admin-only.** With Delta 1 in place,
`user:update` no longer implies role assignment, so the escalation path is closed and the
grant is safe. Removal stays with admin because it is irreversible, changes seat billing,
and `status: 'suspended'` — which supervisors now have — covers every operational need
("this person is gone, cut their access now") without destroying history.

**Rejected — grant both.** Simpler to explain, one fewer asymmetry. Rejected because a
supervisor is a shift-level role, and an accidental account deletion is unrecoverable while
a suspension is one click back.

## Delta 3 — invariants on role writes, and one new error code

Permissions answer "may this principal perform this operation". They do not answer "is the
resulting state coherent". Four invariants, all enforced server-side in the same transaction
as the write:

1. **No principal may change their own `role`** — including an admin. `forbidden`. Makes
   every escalation require a second person, and removes the commonest self-lockout.
2. **No principal may grant a role above their own.** Ordering: `agent < supervisor <
admin`. Under Deltas 1–2 this is already implied, but it is stated as an invariant so
   that adding a fourth role later cannot silently open a path.
3. **The last active admin cannot be demoted, suspended, or removed.** New error code
   `last_admin_required` → **409**. The check counts `users WHERE role = 'admin' AND status
= 'active'` inside the writing transaction, with the row locked
   (`SELECT … FOR UPDATE`); an unlocked read makes two concurrent demotions able to zero
   out the set. This is a genuine lockout risk, not a theoretical one — a tenant with no
   admin cannot manage billing, branding or its WhatsApp credentials and can only be
   recovered by platform support.
4. **Assignment references must be cleared before the referent is deleted.**
   `conversations.assigned_user_id` / `assigned_team_id` are `ON DELETE NO ACTION` in
   TAR-80's schema. So `DELETE /users/{id}` must null the deleted user's conversation and
   ticket assignments in the same transaction, or the FK raises and the endpoint answers
   `internal_error`. There is no team-delete endpoint in TAR-39's surface; if TAR-81 adds
   one, it must reassign first or answer `conflict` — and it must never leave a record
   assigned to a team nobody belongs to, because such a record is invisible to every role
   without `_all`.

Every one of these mutations writes an `audit_logs` row (the table landed in TAR-80):

| Action                                   | `target_type` | Metadata (redacted, no PII)      |
| ---------------------------------------- | ------------- | -------------------------------- |
| `user.invited`                           | `user`        | role, teamIds                    |
| `user.role_changed`                      | `user`        | from, to                         |
| `user.status_changed`                    | `user`        | from, to                         |
| `user.teams_changed`                     | `user`        | added, removed                   |
| `user.removed`                           | `user`        | role at removal                  |
| `team.created` / `.updated` / `.deleted` | `team`        | name, member delta               |
| `session.revoked`                        | `user`        | reason (`role_change`, `logout`) |

## Interim role resolution, before TAR-35

TAR-35 has not landed, so there is no session to read a role from. Both halves of the
interim answer follow the same rule: **stub the source of the principal, never the guard.**
`PermissionGuard` and the visibility predicate run identically before and after TAR-35, so
what TAR-83 tests now is the real enforcement path with a different principal supplier.

### Frontend — already shipped in TAR-82, confirmed as the contract

Cookie `wac_role_stub` (deliberately not `wac_session`), read server-side, principal built
by `buildStubPrincipal` through `permissionsForRole`. Two independent kill switches:
`NEXT_PUBLIC_ENABLE_ROLE_STUB` off by default, plus `resolveSession()` refusing the stub in
production regardless of the flag. Correct as built; no changes asked for.

### API — for TAR-81 to build

- Introduce a `PrincipalSource` provider in `CoreModule` with two implementations:
  `SessionPrincipalSource` (TAR-35) and `StubPrincipalSource` (interim). The pipeline slot
  is unchanged; nothing downstream of slot 3 knows which is bound. Swapping to TAR-35 is a
  one-line module change plus deleting the stub.
- **Read the same `wac_role_stub` cookie the console already sets**, so one switch in the UI
  drives both halves and they cannot disagree. Accept `x-dev-role` as an override for curl
  and integration tests; the header wins when both are present.
- **`tenantId` and `userId` must not be constants.** `tenantId` comes from
  `HostTenantGuard` (slot 2, already resolved from the request host); `userId` and `teamIds`
  come from a real seeded user holding that role in that tenant. A hardcoded tenant id
  would bypass the GUC that RLS depends on, and TAR-81's tests would pass with tenant
  isolation never exercised — the failure mode 0002 warns about in its "the schema is not
  the guarantee" note. Until TAR-46 lands seed data, TAR-81 seeds three users (one per role,
  two teams, at least one conversation assigned to each of user/team/nobody) in its own
  fixture.
- **`permissions` from `permissionsForRole(role)`.** Never a literal array, in the stub or
  anywhere else.
- **Two kill switches, mirroring the frontend.** `AUTH_STUB_ENABLED`, default false; plus a
  refusal at _bootstrap_ — not per request — when `NODE_ENV === 'production'`. Failing at
  startup means a misconfigured deploy cannot serve a single request with a stubbed
  principal. Add a CI assertion that the production config cannot enable it.
- The stub grants nothing. Every request still passes `PermissionGuard`, and unit tests for
  the matrix construct principals directly rather than through the cookie.

### What must be re-verified once TAR-35 lands

For TAR-83's plan and TAR-84's review, this is the list, and it is short by design:

1. The principal is built from a real session row, with `permissions` still materialised via
   `permissionsForRole`.
2. Session revocation on role, status and team-membership change (the Decision 2 amendment)
   actually logs the user out.
3. `tenant_mismatch` fires when a session is replayed against another tenant's host.
4. Both stub kill switches are gone or provably inert in the production config.

## Failure Modes and Operations

| Condition                                     | Behaviour                                                     | What to watch                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Role changed mid-session                      | Sessions revoked, forced re-login (Decision 2 amendment)      | Rate of `session.revoked` with reason `role_change`                                                            |
| Stub enabled outside dev                      | Process refuses to boot                                       | Startup failure; CI config assertion                                                                           |
| Caller requests a scope wider than permitted  | Silently narrowed, notice rendered — never 403                | —                                                                                                              |
| Principal cache unavailable                   | Falls back to the `sessions` table; slower, still correct     | Login latency                                                                                                  |
| New permission added to `PERMISSIONS`         | Reaches `admin` automatically, since `admin` is the whole set | Review gate: a new _destructive_ permission is admin-granted with no explicit decision — call it out in the PR |
| Record assigned to an emptied or deleted team | Invisible to every role without `_all`                        | Invariant 4 prevents it; alert on records assigned to a team with zero members                                 |
| Permission added but granted to no role       | Endpoint unreachable except by admin                          | A contract test asserting every permission is reachable by at least one role                                   |

## Security and Access

The matrix is a UI-independent, server-side check — 0002 already says the console hiding a
button is presentation, not access control, and TAR-82's own comments repeat it. Three
things worth restating because they are where RBAC bugs actually come from:

- **`not_found`, never `forbidden`, for another tenant's record.** A 403 confirms the id
  exists. Within a tenant, a record the principal may not see under the visibility
  predicate is also `not_found` — a 403 there would confirm that a conversation exists with
  another team, which is a small but real leak.
- **`forbidden` is only for a missing permission on a resource the principal can see.**
- Role, invite, team and session-revocation mutations are all audited (table above). Audit
  metadata carries a redacted before/after and never a secret or a message body.

## Open Questions and Risks

| #   | Item                                                                                       | Severity | Resolution                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OR-predicate index usage for the agent inbox — whether both partial-scope indexes are used | Medium   | Measure in TAR-81 with `EXPLAIN (ANALYZE, BUFFERS)`; fall back to `UNION ALL` keyset pages                                                                     |
| 2   | Agents cannot pull unclaimed work at v1                                                    | Low      | **Resolved in TAR-186**: `conversation:claim`, granted to every role, bounded to the caller's teams' unassigned records. See invariants 6–8                    |
| 3   | Whether a supervisor should be able to delete a team that holds conversations              | Low      | No delete endpoint exists at v1. Invariant 4 governs the day one is added                                                                                      |
| 4   | Tenant-configurable roles                                                                  | Low      | Out of scope. Additive: `ROLE_PERMISSIONS` becomes rows; guards do not change                                                                                  |
| 5   | Does `contact:read` being tenant-wide leak across teams?                                   | Low      | Accepted: a contact carries no assignment, and an agent handling a conversation needs the person on it. Revisit if a tenant asks for team-partitioned contacts |

## What each downstream task does with this

| Task       | Action                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TAR-80** | **No schema change.** Role enum, `teams`, `team_members`, both inbox/queue indexes and `audit_logs` all align. The three deltas are contract-file and guard-logic only. Merge as reviewed.                                                                                           |
| **TAR-81** | Apply the `rbac.ts` diff (Deltas 1–2) and `last_admin_required` to `error-codes.ts`; implement `PermissionGuard`, the visibility predicate as shared code, the four invariants, audit writes, session revocation on role/status/team change, and `StubPrincipalSource`.              |
| **TAR-82** | Re-check after the `rbac.ts` change: supervisors gain the person-edit control, and the role selector must be gated on `user:set_role`, not on `user:update`. Everything else — the stub, `allowedConversationScopes`, the narrowing notice — is confirmed as built.                  |
| **TAR-83** | Test the matrix cell by cell per role; the three visibility cases (own / team / neither); scope narrowing rather than 403; the four invariants, especially last-admin and self-demotion; cross-tenant `not_found` under all three roles; then the four TAR-35 re-verification items. |
| **TAR-84** | Confirm no `role === 'admin'` comparison outside `rbac.ts`; both stub kill switches present and bootstrap-failing; `SystemPrisma` unused in this story; the last-admin check inside a locking transaction, not a read-then-write.                                                    |
