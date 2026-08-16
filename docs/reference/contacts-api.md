# Contacts, tags and custom fields API reference

The eleven routes behind the CRM core — `/api/v1/contacts`, `/api/v1/tags` and
`/api/v1/custom-fields` — and the rules a client cannot discover from the shapes alone.
Written for engineers building against the API or the console.

Three resources sit here because they are one subject seen from three angles. A **contact**
is a customer the tenant has talked to on WhatsApp. A **tag** is a label any agent may put
on one, and the same taxonomy the routing engine and workflows read. A **custom field
definition** is a column the tenant adds to its own contact record: an admin defines it
once, and every contact profile gains it.

Request and response shapes are defined in `packages/contracts/src/contacts.ts` and
validated at the boundary. Enforcement lives in `apps/api/src/contacts/` and
`apps/api/src/tags/`. The design and its trade-offs are
[0002 amendment 10](../architecture/0002-architecture-and-api-contract.md); the table
shapes are [the data model reference](data-model.md#contacts--tar-33). Where this page and
amendment 10 disagree, this page describes what shipped — the differences are called out
under [Deviations from amendment 10](#deviations-from-amendment-10).

For admins defining fields in the console rather than calling the API, read
[Define the fields your contacts carry](../guides/define-custom-contact-fields.md). For
agents tagging and finding people, read
[Find a contact and keep their record up to date](../guides/find-and-update-contacts.md).

## Conventions

| Concern               | Rule                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| Base path             | `/api/v1`                                                                          |
| Tenant                | Resolved from the request `Host`, never from a body, header or query parameter     |
| Bodies                | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                    |
| Contact and tag lists | `{ items, nextCursor }`, keyset paginated. `limit` 1–100, default 25               |
| Definition list       | `{ items, nextCursor }` with **`nextCursor` fixed at `null`** — it never paginates |
| Timestamps            | ISO 8601 with an explicit offset                                                   |
| Error shape           | The standard envelope, with a code from `packages/contracts/src/error-codes.ts`    |
| `Idempotency-Key`     | Not used here. Nothing on this surface has an external side effect                 |

**The definition list is the one deviation from 0002's pagination rule, and it has a
reason.** `CUSTOM_FIELD_LIMITS.definitionsPerTenant` is enforced on create, and both
readers — the contact profile form and the routing-rule condition dropdown — need the set
whole. The `CursorPage` shape is retained with `nextCursor` fixed at `null`, so a generic
list client works against it unchanged and pagination stays addable without a breaking
change.

## Authentication

Every route requires a signed-in user presenting the session cookie `wac_session` —
`__Host-wac_session` wherever `SESSION_COOKIE_SECURE` is on. Three global guards run before
any handler: **where** the request is (`HostTenantGuard`), **who** is making it
(`PrincipalGuard`), then **may they** (`PermissionGuard`).

| Condition                                        | Answer                |
| ------------------------------------------------ | --------------------- |
| No cookie, or an expired, revoked or unknown one | `401 unauthenticated` |
| A valid session belonging to a different tenant  | `401 tenant_mismatch` |
| Signed in, but the role lacks the permission     | `403 forbidden`       |
| The record is in another tenant                  | `404 not_found`       |

## Permissions

| Route                                | Permission        | Held by                  |
| ------------------------------------ | ----------------- | ------------------------ |
| `GET /api/v1/contacts`               | `contact:read`    | agent, supervisor, admin |
| `POST /api/v1/contacts`              | `contact:write`   | agent, supervisor, admin |
| `GET /api/v1/contacts/{id}`          | `contact:read`    | agent, supervisor, admin |
| `PATCH /api/v1/contacts/{id}`        | `contact:write`   | agent, supervisor, admin |
| `GET /api/v1/tags`                   | `contact:read`    | agent, supervisor, admin |
| `POST /api/v1/tags`                  | `contact:write`   | agent, supervisor, admin |
| `GET /api/v1/custom-fields`          | `contact:read`    | agent, supervisor, admin |
| `POST /api/v1/custom-fields`         | `tenant:settings` | **admin only**           |
| `PATCH /api/v1/custom-fields/{id}`   | `tenant:settings` | **admin only**           |
| `DELETE /api/v1/custom-fields/{id}`  | `tenant:settings` | **admin only**           |
| `POST /api/v1/custom-fields/reorder` | `tenant:settings` | **admin only**           |

**Defining a field is `tenant:settings`; filling one in is `contact:write`.** That split is
TAR-33's first acceptance criterion, and it is why the write half is not `contact:write`:
every agent holds that one, so carrying definition writes on it would let any agent
redefine the tenant's contact record. `tenant:settings` was already in `PERMISSIONS` and in
no role list but admin's, so `rbac.ts` is unchanged. Reads are `contact:read` because every
agent has to render the fields to fill them in — a definition list is labels and option
lists, never a contact's data.

**Creating a tag is `contact:write`, not `tenant:settings`.** A tag is a label an agent puts
on a customer mid-conversation; a custom field changes the shape of every contact record in
the tenant. The two are not the same authority, and the permissions say so.

**Contacts are not subject to the ticket visibility predicate.** The `_all` widening that
separates an agent from a supervisor on conversations and tickets does not apply here: an
agent picking up a thread has to be able to read the customer on the other end of it. Every
principal holding `contact:read` sees every contact, tag and definition in the tenant.

## The contact

```json
{
  "id": "019fee10-4b71-7c02-9a3d-5e81f2c47b09",
  "phone": "+966501234567",
  "waProfileName": "Layla Haddad",
  "displayName": "Layla Haddad",
  "email": "layla.haddad@example.com",
  "tags": [{ "id": "019fee0a-2c14-7f83-8b60-1d9a4e7c3f52", "name": "VIP", "color": "#112233" }],
  "customFields": { "plan_tier": "gold", "renewal_date": "2027-03-01" },
  "lastContactedAt": "2026-08-14T11:42:07.913+03:00",
  "optedOutAt": null,
  "createdAt": "2026-06-02T08:15:33.201+03:00",
  "updatedAt": "2026-08-14T11:42:07.913+03:00"
}
```

| Field             | Type                | Notes                                                                      |
| ----------------- | ------------------- | -------------------------------------------------------------------------- |
| `phone`           | E.164 string        | The WhatsApp identity and the tenant dedupe key. **Not editable**          |
| `waProfileName`   | string or `null`    | What Meta last reported as the customer's own profile name                 |
| `displayName`     | string, 1–120       | What to render. Falls back to `phone` when the stored name is null         |
| `email`           | string or `null`    | `citext`, so `q` matches it case-insensitively. **Not** unique             |
| `tags`            | array of tags       | The whole set. Written by `tagIds` on create and update                    |
| `customFields`    | object              | Keyed by definition `key`. See [Custom field values](#custom-field-values) |
| `lastContactedAt` | timestamp or `null` | Denormalised from `contacts.last_seen_at`; the conversation is the truth   |
| `optedOutAt`      | timestamp or `null` | Non-null blocks every outbound send, templates included                    |

**`waProfileName` and `displayName` read the same column today.** The schema carries one
`display_name`, written by the ingest pipeline from Meta's profile name and overridden by an
agent through `PATCH`. The contract publishes both because they are different questions —
what Meta said, and what to render — and `contact.mapper.ts` resolves them in one place, so
they diverge the day the column does and no consumer changes.

**There is no `DELETE /api/v1/contacts/{id}`.** `contact:delete` exists in the permission
vocabulary and 0002 publishes no route for it: erasing a customer touches conversations,
tickets and the retention policy, and belongs to the story that owns those.

### Custom field values

`customFields` is `Record<string, string | null>`, keyed by the definition's `key` and never
by its `id`. Keying the wire format by `id` would mean translating on every read and write
of the hottest object in the product, and would leave the routing engine speaking a
different language from the API about the same field. `key` being immutable is what makes it
safe as a wire key.

| Concern           | Rule                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| Response contents | Every defined field the contact has a value for. Never-set keys are **absent** |
| Write semantics   | **Merge.** Keys present are set, `null` clears one, absent keys are left alone |
| Unknown key       | `400 validation_failed` — never silently dropped                               |
| Ordering          | The definition list's, not this object's. JSON object order carries no meaning |

**Merge, not replace, is the decision worth naming.** Replacement would make an agent who
edits a phone number silently erase every custom value their form did not happen to load.
The cost is that "clear this field" has to be an explicit `null` rather than an omission —
one line in a client, and it cannot lose anything.

**Only the keys a write carries are validated.** That is what makes removing a `select`
option safe: a contact holding the removed value keeps it until that field is next written,
and saving some _other_ field is not blocked by it.

Values are validated per type by `customFieldValueIssue` in
`packages/contracts/src/contacts.ts` — one function, so a console can disable a save the API
would refuse instead of keeping a second copy of the rules.

| Type      | A value is legal when                                   | Rejection message                          |
| --------- | ------------------------------------------------------- | ------------------------------------------ |
| `text`    | At most 500 characters                                  | `Must be at most 500 characters`           |
| `number`  | Parses finite. A blank or padded string does **not**    | `Must be a number`                         |
| `boolean` | Exactly `"true"` or `"false"`                           | ``Must be `true` or `false` ``             |
| `date`    | `YYYY-MM-DD`, a real calendar date, no time and no zone | ``Must be a calendar date, `YYYY-MM-DD` `` |
| `select`  | One of the definition's **current** options             | `Must be one of the defined options`       |

A `null` passes for every type: clearing a field is always legal. A `date` is a calendar
date rather than an instant because a renewal date is not a moment in time, and
`TimestampSchema` would make it one.

Failures land as `400 validation_failed` with one `details` entry per offending key, at path
`customFields.<key>`. Every issue is collected before answering rather than failing on the
first, so an agent fixing a form is told about all of it at once.

## The custom field definition

```json
{
  "id": "019fee0f-9a33-7d41-b8c7-6f0e2a5b91d4",
  "key": "plan_tier",
  "label": "Plan tier",
  "type": "select",
  "options": ["bronze", "silver", "gold"],
  "position": 0,
  "createdAt": "2026-08-10T09:02:11.004+03:00",
  "updatedAt": "2026-08-10T09:02:11.004+03:00"
}
```

| Field      | Type         | Notes                                                                     |
| ---------- | ------------ | ------------------------------------------------------------------------- |
| `key`      | string, 1–40 | `^[a-z][a-z0-9_]*$`, unique per tenant, **immutable**. Not a reserved key |
| `label`    | string, 1–80 | What a person sees. Renameable at any time                                |
| `type`     | enum         | `text`, `number`, `boolean`, `date`, `select`. **Immutable**              |
| `options`  | array        | Non-empty exactly when `type` is `select`; distinct, 1–80 characters each |
| `position` | integer ≥ 0  | Display order. Server-assigned; changed only by `reorder`                 |

Reserved keys, refused at definition time: `id`, `phone`, `email`, `name`, `display_name`,
`tags`, `locale`. Nothing breaks if one is used — the routing engine reads
`contacts.custom_fields` and only that — but a tenant-defined `email` rendered beside the
real `email` is a support ticket waiting to happen, and refusing costs one array.

### `key` and `type` are immutable

`PATCH` accepts `label` and `options`, and nothing else. This is the load-bearing rule of
the surface, and it follows from where values live rather than from taste.

- **`key`** is the JSONB key inside `contacts.custom_fields`, and the key a
  `contact_attribute` routing condition names
  ([0007](../architecture/0007-routing-rules-and-assignment-fallback.md)). Renaming it
  orphans every contact's value and silently stops every rule naming it from ever matching —
  the worst failure shape available, because routing that quietly matches nothing looks like
  routing that works.
- **`type`** is what every already-stored value was validated against, and nothing
  re-validates them. Flipping `text` → `number` on a field holding `"Gold tier"` leaves an
  agent with a profile the API refuses to save back, and the field they must fix is not the
  one they opened the contact for.

Both are delete-and-recreate. `label` exists precisely so the user-visible name can change
freely.

### Limits

Published as `CUSTOM_FIELD_LIMITS` in `packages/contracts/src/contacts.ts`, so the API, the
console and the design document cannot drift.

| Limit                  | Value | Covers                                              |
| ---------------------- | ----- | --------------------------------------------------- |
| `definitionsPerTenant` | 50    | Definitions the tenant may hold. Enforced on create |
| `keyLength`            | 40    | Characters in a `key`                               |
| `labelLength`          | 80    | Characters in a `label`                             |
| `optionsPerDefinition` | 50    | Options in one `select`                             |
| `optionLength`         | 80    | Characters in one option                            |
| `textValueLength`      | 500   | Characters in a stored `text` value                 |

50 sits under `CursorPageQuerySchema`'s ceiling of 100, so the `?limit=100` a client may
already send at the definition list can never truncate the vocabulary.

**`multi_select` is not offered.** The Postgres enum `custom_field_type` carries six labels
and `CUSTOM_FIELD_TYPES` publishes five. A value is a single string, so multi-select would
need an encoding decision plus "any of" semantics for the routing engine's `equals` and
`contains` operators — neither of which TAR-33 asks for. The label stays in the database
because dropping it is a migration that buys nothing; `CustomFieldTypeSchema` is what refuses
it at the edge. A stored row carrying it — writable only by hand — raises rather than being
rendered as `text`, and reaches the caller as `500 internal_error` with the key in the log.

## The tag

```json
{ "id": "019fee0a-2c14-7f83-8b60-1d9a4e7c3f52", "name": "VIP", "color": "#112233" }
```

| Field   | Type         | Notes                                                 |
| ------- | ------------ | ----------------------------------------------------- |
| `name`  | string, 1–40 | Unique per tenant, **case-sensitively** — see below   |
| `color` | `#rrggbb`    | Optional on the way in, always present on the way out |

**Tag uniqueness is case-sensitive, unlike teams and routing rules.** `teams.name` and
`assignment_rules.name` are `citext`; `tags.name` is plain `text`, so `VIP` and `vip` are two
tags a tenant can genuinely hold. The case-insensitivity of the `q` filter comes from the
query (`mode: 'insensitive'`), not from the column — do not remove it as redundant. Making
the column `citext` is a retype on a table `contact_tags`, `ticket_tags` and
`workflow_references` all reference, so it is raised for the schema owner rather than done
here.

`color` is nullable in the column and required in the response: a tag created without one
renders as `#64748b`, the neutral slate from the design tokens — readable on both themes, and
visibly not a choice somebody made. A tag with no colour is still a tag, and dropping it from
a response would silently narrow a filter an agent set.

**There is no `PATCH`, `DELETE` or `GET /{id}` for tags.** 0002 publishes two routes, the
list _is_ the resource for a set this small, and deleting a tag has to reckon with
`workflow_references` refusing it while a workflow names one — which belongs in its own
story rather than being invented here.

## `GET /api/v1/contacts`

The contact directory, newest first. Keyset paginated on `id` descending; ids are UUIDv7 and
therefore already in creation order, so one column does the work of `(created_at, id)`.

| Parameter | In    | Type    | Required | Default | Notes                                          |
| --------- | ----- | ------- | -------- | ------- | ---------------------------------------------- |
| `q`       | query | string  | no       | —       | 1–120 characters. Matches name, phone or email |
| `tagId`   | query | UUID    | no       | —       | Only contacts carrying this tag                |
| `cursor`  | query | string  | no       | —       | `nextCursor` from the previous page            |
| `limit`   | query | integer | no       | `25`    | 1–100                                          |

```bash
curl -b cookies.txt 'https://acme.app.example.com/api/v1/contacts?tagId=019fee0a-2c14-7f83-8b60-1d9a4e7c3f52&limit=2'
```

```json
{
  "items": [
    {
      "id": "019fee10-4b71-7c02-9a3d-5e81f2c47b09",
      "phone": "+966501234567",
      "waProfileName": "Layla Haddad",
      "displayName": "Layla Haddad",
      "email": "layla.haddad@example.com",
      "tags": [{ "id": "019fee0a-2c14-7f83-8b60-1d9a4e7c3f52", "name": "VIP", "color": "#112233" }],
      "customFields": { "plan_tier": "gold" },
      "lastContactedAt": "2026-08-14T11:42:07.913+03:00",
      "optedOutAt": null,
      "createdAt": "2026-06-02T08:15:33.201+03:00",
      "updatedAt": "2026-08-14T11:42:07.913+03:00"
    }
  ],
  "nextCursor": null
}
```

| Status | Code                | Cause                                    |
| ------ | ------------------- | ---------------------------------------- |
| `200`  | —                   |                                          |
| `400`  | `validation_failed` | `limit` out of range, `tagId` not a UUID |
| `401`  | `unauthenticated`   | No session                               |
| `403`  | `forbidden`         | No `contact:read`                        |

**`q` is a single term matched against name, phone and email**, not a filter DSL. `email` is
`citext` and already case-insensitive at the column; `display_name` is plain text and the
query supplies the mode; `phone_e164` matches as typed. None is index-backed — this is a
substring search over the tenant's contacts, and the tenant predicate is what bounds it. A
trigram index is the answer if a directory outgrows a scan, and it is a change to one
function.

**`tagId` is an `EXISTS` over `contact_tags`, not a join**, so a contact carrying the tag
appears once. A tag id belonging to another tenant matches nothing and answers an empty page
— row-level security means it is simply not visible, and a 404 there would confirm the id
exists somewhere.

## `POST /api/v1/contacts`

Creates a contact.

**Idempotency.** No `Idempotency-Key`. 0002 requires one for calls with external side
effects; this writes rows and has none. Replaying the call answers `409 conflict` on the
duplicate phone number.

| Parameter      | In   | Type   | Required | Default | Notes                                         |
| -------------- | ---- | ------ | -------- | ------- | --------------------------------------------- |
| `phone`        | body | string | yes      | —       | E.164. The tenant-unique identity             |
| `displayName`  | body | string | yes      | —       | 1–120 characters                              |
| `email`        | body | string | no       | `null`  | Nullable                                      |
| `tagIds`       | body | array  | no       | `[]`    | Tags in this tenant                           |
| `customFields` | body | object | no       | —       | Validated against the definitions, as a merge |

```bash
curl -X POST https://acme.app.example.com/api/v1/contacts \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
        "phone": "+966501234567",
        "displayName": "Layla Haddad",
        "email": "layla.haddad@example.com",
        "tagIds": ["019fee0a-2c14-7f83-8b60-1d9a4e7c3f52"],
        "customFields": { "plan_tier": "gold" }
      }'
```

| Status | Code                | Cause                                                                       |
| ------ | ------------------- | --------------------------------------------------------------------------- |
| `201`  | —                   |                                                                             |
| `400`  | `validation_failed` | Bad shape, a `tagId` not in this tenant, an unknown or illegal custom field |
| `401`  | `unauthenticated`   | No session                                                                  |
| `403`  | `forbidden`         | No `contact:write`                                                          |
| `409`  | `conflict`          | A contact with that `phone` already exists in this tenant                   |

**A create validates custom fields exactly as an update does.** There is nothing stored to
merge into, so the same merge runs against an empty map — which is what refuses an unknown
key here as well as there.

**A tag belonging to another tenant is `validation_failed` on `tagIds`, not `not_found`.**
The missing thing is not the resource being addressed, and row-level security means the
server genuinely cannot tell another tenant's tag from a tag that never existed. The refusal
names the field, which is what a client needs, and confirms nothing about the id. Nothing is
written: the check runs inside the write transaction, before the insert.

**Most contacts are not created here.** The ingest pipeline creates one the first time
somebody messages the tenant (TAR-20), and the console offers no screen that invents one.
This route exists for imports and for API consumers.

## `GET /api/v1/contacts/{id}`

One contact.

| Status | Code                | Cause                                   |
| ------ | ------------------- | --------------------------------------- |
| `200`  | —                   |                                         |
| `400`  | `validation_failed` | `{id}` is not a UUID                    |
| `401`  | `unauthenticated`   | No session                              |
| `403`  | `forbidden`         | No `contact:read`                       |
| `404`  | `not_found`         | Unknown id, or another tenant's contact |

## `PATCH /api/v1/contacts/{id}`

Partial update of identity, tags and custom field values. This is also the assign-and-remove
route for tags.

| Parameter      | In   | Type             | Required | Notes                                               |
| -------------- | ---- | ---------------- | -------- | --------------------------------------------------- |
| `displayName`  | body | string           | no       | 1–120 characters                                    |
| `email`        | body | string or `null` | no       |                                                     |
| `tagIds`       | body | array            | no       | **Replaces** the contact's tags with this exact set |
| `customFields` | body | object           | no       | **Merges** into the stored map                      |

`phone` is absent from the schema. It is the identity key, and merging two contacts is a
separate operation.

```bash
curl -X PATCH https://acme.app.example.com/api/v1/contacts/019fee10-4b71-7c02-9a3d-5e81f2c47b09 \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
        "tagIds": ["019fee0a-2c14-7f83-8b60-1d9a4e7c3f52"],
        "customFields": { "plan_tier": "gold", "account_manager": null }
      }'
```

```json
{
  "id": "019fee10-4b71-7c02-9a3d-5e81f2c47b09",
  "phone": "+966501234567",
  "waProfileName": "Layla Haddad",
  "displayName": "Layla Haddad",
  "email": "layla.haddad@example.com",
  "tags": [{ "id": "019fee0a-2c14-7f83-8b60-1d9a4e7c3f52", "name": "VIP", "color": "#112233" }],
  "customFields": { "plan_tier": "gold", "renewal_date": "2027-03-01" },
  "lastContactedAt": "2026-08-14T11:42:07.913+03:00",
  "optedOutAt": null,
  "createdAt": "2026-06-02T08:15:33.201+03:00",
  "updatedAt": "2026-08-16T10:03:55.618+03:00"
}
```

That call set `plan_tier`, cleared `account_manager`, and left `renewal_date` exactly as it
was — the difference between a merge and a replacement, in one body.

| Status | Code                | Cause                                                                                     |
| ------ | ------------------- | ----------------------------------------------------------------------------------------- |
| `200`  | —                   |                                                                                           |
| `400`  | `validation_failed` | Bad shape, a `tagId` not in this tenant, an unknown or illegal custom field               |
| `401`  | `unauthenticated`   | No session                                                                                |
| `403`  | `forbidden`         | No `contact:write`                                                                        |
| `404`  | `not_found`         | Unknown id, or another tenant's contact. Never `forbidden`, which would confirm it exists |

**`tagIds` replaces and `customFields` merges, and the asymmetry is deliberate.** A tag list
is a small set an agent sees whole on the screen they are editing; a custom-field map is
rendered from a definition list a form may only have loaded part of. Sending `tagIds: []`
removes every tag; omitting `tagIds` changes none.

**The definitions are read inside the write transaction**, so a field cannot be deleted
between validating a value against it and storing that value.

## `GET /api/v1/tags`

The tenant's whole taxonomy, oldest first. Keyset paginated on `id` ascending — unlike the
contact directory, because tags are a small, stable set a picker renders whole, and
newest-first would reshuffle it every time an agent coins a label mid-conversation.

| Parameter | In    | Type    | Required | Default | Notes                                       |
| --------- | ----- | ------- | -------- | ------- | ------------------------------------------- |
| `q`       | query | string  | no       | —       | 1–40 characters, matched case-insensitively |
| `cursor`  | query | string  | no       | —       | `nextCursor` from the previous page         |
| `limit`   | query | integer | no       | `25`    | 1–100                                       |

```bash
curl -b cookies.txt 'https://acme.app.example.com/api/v1/tags?q=vip'
```

```json
{
  "items": [{ "id": "019fee0a-2c14-7f83-8b60-1d9a4e7c3f52", "name": "VIP", "color": "#112233" }],
  "nextCursor": null
}
```

| Status | Code                | Cause                       |
| ------ | ------------------- | --------------------------- |
| `200`  | —                   |                             |
| `400`  | `validation_failed` | `limit` or `q` out of range |
| `401`  | `unauthenticated`   | No session                  |
| `403`  | `forbidden`         | No `contact:read`           |

**Tags have no server-side cap.** A client that reads only the first page is reading a
partial vocabulary, and the consequence is not a short dropdown — it is a _wrong label_: a
contact holding a tag past the cap renders as "no longer available" when the tag is in daily
use. Page to `nextCursor === null`, or say out loud that the read was truncated.

## `POST /api/v1/tags`

Coins a label. Any agent may.

| Parameter | In   | Type   | Required | Default   | Notes                              |
| --------- | ---- | ------ | -------- | --------- | ---------------------------------- |
| `name`    | body | string | yes      | —         | 1–40 characters, unique per tenant |
| `color`   | body | string | no       | `#64748b` | `#rrggbb`                          |

```bash
curl -X POST https://acme.app.example.com/api/v1/tags \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"name":"VIP","color":"#112233"}'
```

```json
{ "id": "019fee0a-2c14-7f83-8b60-1d9a4e7c3f52", "name": "VIP", "color": "#112233" }
```

| Status | Code                | Cause                                                   |
| ------ | ------------------- | ------------------------------------------------------- |
| `201`  | —                   |                                                         |
| `400`  | `validation_failed` | Name length, or a `color` that is not `#rrggbb`         |
| `401`  | `unauthenticated`   | No session                                              |
| `403`  | `forbidden`         | No `contact:write`                                      |
| `409`  | `conflict`          | A tag with that exact name — same case — already exists |

## `GET /api/v1/custom-fields`

The tenant's whole vocabulary, in display order: `position` ascending, ties broken on `id`.
Takes no parameters; unknown query keys are ignored.

The tie-break is load-bearing rather than cosmetic. `position` defaults to `0` and carries no
unique constraint, so without it two definitions created before `reorder` was ever called
have no defined order, and the profile form would render them differently between two
requests. Ids are UUIDv7, so a tie resolves in creation order.

```bash
curl -b cookies.txt https://acme.app.example.com/api/v1/custom-fields
```

```json
{
  "items": [
    {
      "id": "019fee0f-9a33-7d41-b8c7-6f0e2a5b91d4",
      "key": "plan_tier",
      "label": "Plan tier",
      "type": "select",
      "options": ["bronze", "silver", "gold"],
      "position": 0,
      "createdAt": "2026-08-10T09:02:11.004+03:00",
      "updatedAt": "2026-08-10T09:02:11.004+03:00"
    },
    {
      "id": "019fee0f-c188-7a05-9d2e-3b7c60f4ad81",
      "key": "renewal_date",
      "label": "Renewal date",
      "type": "date",
      "options": [],
      "position": 1,
      "createdAt": "2026-08-10T09:04:47.882+03:00",
      "updatedAt": "2026-08-10T09:04:47.882+03:00"
    }
  ],
  "nextCursor": null
}
```

| Status | Code              | Cause             |
| ------ | ----------------- | ----------------- |
| `200`  | —                 |                   |
| `401`  | `unauthenticated` | No session        |
| `403`  | `forbidden`       | No `contact:read` |

`nextCursor` is always `null`. The read takes one row more than the cap, so a set that
somehow exceeded 50 is visible as a fault rather than silently truncated to look complete.

There is deliberately **no `GET /api/v1/custom-fields/{id}`** — the list _is_ the resource,
and a client that has it has the row.

## `POST /api/v1/custom-fields`

Defines a field. Every contact profile in the tenant gains it immediately; no contact row is
written.

| Parameter | In   | Type   | Required | Default | Notes                                           |
| --------- | ---- | ------ | -------- | ------- | ----------------------------------------------- |
| `key`     | body | string | yes      | —       | `^[a-z][a-z0-9_]*$`, 1–40, not reserved, unique |
| `label`   | body | string | yes      | —       | 1–80 characters                                 |
| `type`    | body | enum   | yes      | —       | `text`, `number`, `boolean`, `date`, `select`   |
| `options` | body | array  | no       | `[]`    | Required for `select`, forbidden otherwise      |

`position` is deliberately not accepted. It is assigned server-side as `max(position) + 1`,
so two admins creating a field at the same moment do not both land on `0`.

```bash
curl -X POST https://acme.app.example.com/api/v1/custom-fields \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
        "key": "plan_tier",
        "label": "Plan tier",
        "type": "select",
        "options": ["bronze", "silver", "gold"]
      }'
```

```json
{
  "id": "019fee0f-9a33-7d41-b8c7-6f0e2a5b91d4",
  "key": "plan_tier",
  "label": "Plan tier",
  "type": "select",
  "options": ["bronze", "silver", "gold"],
  "position": 0,
  "createdAt": "2026-08-10T09:02:11.004+03:00",
  "updatedAt": "2026-08-10T09:02:11.004+03:00"
}
```

| Status | Code                | Cause                                                                     |
| ------ | ------------------- | ------------------------------------------------------------------------- |
| `201`  | —                   |                                                                           |
| `400`  | `validation_failed` | Key format, a reserved key, `options` not matching `type`, a length bound |
| `401`  | `unauthenticated`   | No session                                                                |
| `403`  | `forbidden`         | No `tenant:settings` — **including supervisor**                           |
| `409`  | `conflict`          | Duplicate `key`, or `definitionsPerTenant` already reached                |

**The cap is checked, then the row is written**, so two creates racing at the boundary can
both pass and leave the tenant one field over 50. Accepted rather than locked: the
consequence is a 51st definition on a bound that exists to keep the list unpaginated, not a
correctness failure, and an advisory lock on every create would be heavier than the risk.

Reaching the cap is `conflict`, not `plan_limit_exceeded`. The cap is a property of the
surface — the list is unpaginated and the routing-rule dropdown reads it whole — not of the
tenant's plan, and a 402 would send an admin to the billing page to fix something money
cannot.

## `PATCH /api/v1/custom-fields/{id}`

Renames a field, or edits a `select`'s options. Nothing else.

| Parameter | In   | Type   | Required | Notes                                          |
| --------- | ---- | ------ | -------- | ---------------------------------------------- |
| `label`   | body | string | no       | 1–80 characters                                |
| `options` | body | array  | no       | Only on a `select`, and it must stay non-empty |

At least one of the two must be present.

```bash
curl -X PATCH https://acme.app.example.com/api/v1/custom-fields/019fee0f-9a33-7d41-b8c7-6f0e2a5b91d4 \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"label":"Account tier","options":["silver","gold","platinum"]}'
```

| Status | Code                | Cause                                                                      |
| ------ | ------------------- | -------------------------------------------------------------------------- |
| `200`  | —                   |                                                                            |
| `400`  | `validation_failed` | `{id}` not a UUID, an empty body, or `options` against a non-`select` type |
| `401`  | `unauthenticated`   | No session                                                                 |
| `403`  | `forbidden`         | No `tenant:settings`                                                       |
| `404`  | `not_found`         | Unknown id, or another tenant's definition                                 |

**`key` and `type` are not in the schema at all**, so sending either is stripped rather than
refused — unknown keys are stripped per the conventions table, and the schema is what makes
them unreachable. A body carrying *only* `key` or `type` therefore strips to nothing and is
refused as an empty body, which is the honest answer: nothing you asked for was applied. A
client that needs a different key or type deletes the field and defines a new one.

**Removing an option rewrites no contact.** The example above dropped `bronze`; a contact
holding `"bronze"` keeps it, and the profile renders it as-is. It is stale, not corrupt, and
it survives until that field is next written. Refusing the removal while any contact holds
the value would need a scan of the tenant's contacts on every option edit, to protect data
the admin has just said they no longer want.

**`options` is checked against the _stored_ type**, because the update schema sees `options`
without seeing `type`. Sending options for a `text` field is
`validation_failed` at path `options`; emptying a `select`'s options is the same refusal.

## `DELETE /api/v1/custom-fields/{id}`

Removes the definition **and** strips that key from every contact in the tenant, in one
transaction.

| Status | Code                | Cause                                              |
| ------ | ------------------- | -------------------------------------------------- |
| `204`  | —                   |                                                    |
| `400`  | `validation_failed` | `{id}` is not a UUID                               |
| `401`  | `unauthenticated`   | No session                                         |
| `403`  | `forbidden`         | No `tenant:settings`                               |
| `404`  | `not_found`         | Unknown id, or another tenant's definition         |
| `409`  | `conflict`          | A routing rule's `contact_attribute` names the key |

**Not idempotent, unlike the assignment-rule delete.** Deleting an already-deleted definition
is `404`, not `204`, and the difference is deliberate: this call has a second effect, and
reporting success for an id nothing examined would tell an admin their tenant's values under
that key are gone when nothing looked.

**The values go with the definition.** Leaving them orphaned is cheaper and was the obvious
first answer; it has a trap with teeth. Keys are unique per tenant, so an admin who deletes
`national_id` and later creates a field with the same key gets every old value back, on a
screen that gives no hint they were ever there — a data-retention incident produced by two
ordinary settings actions.

The `409` names the offending rules in `details`, one entry per rule at path
`assignmentRuleId` with the rule's id as its message, so an admin can disable them and retry
rather than being told only that something objects. A rule whose condition can never match
again is the silent-failure shape this surface refuses everywhere.

```json
{
  "error": {
    "code": "conflict",
    "message": "Routing rules still match on plan_tier: Gold tier to VIP team. A rule naming a deleted field can never match again, so change or disable them first.",
    "details": [{ "path": "assignmentRuleId", "message": "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa" }],
    "requestId": "6b08881f-0d7d-4e56-939e-4f24492215fa"
  }
}
```

**The strip is a write proportional to the tenant's contact count**, with no index to help
it. That is the accepted cost of a rare, admin-triggered, interactive action, and the
breaking point is stated rather than left to be found: when a tenant's contact count makes
the statement exceed the request timeout, the transaction rolls back whole and nothing is
half-done. The fix at that point is to move the strip to a job, marking the definition
deleted first; nothing in this contract changes when that happens.

The statement is guarded twice beyond what amendment 10 specifies. `jsonb_exists(…)` rather
than the `?` operator, so no driver in the path can read it as a placeholder; and
`jsonb_typeof(custom_fields) = 'object'`, because `custom_fields - 'key'` removes an
_element_ from an array and _raises_ on a scalar — one contact row from an old import would
otherwise turn a settings action into a `500` that aborts the whole delete. Neither shape is
writable through this API. The `contacts_custom_fields_is_object` CHECK constraint (TAR-478)
closes the same gap at the storage layer; the two are complementary, not redundant.

## `POST /api/v1/custom-fields/reorder`

Takes the tenant's **complete** definition set in display order and rewrites `position` to
the array index, in one transaction. Returns the reordered list in the list endpoint's shape.

| Parameter        | In   | Type  | Required | Default | Notes                                             |
| ---------------- | ---- | ----- | -------- | ------- | ------------------------------------------------- |
| `customFieldIds` | body | array | yes      | —       | Every definition the tenant holds, at most 50 ids |

```bash
curl -X POST https://acme.app.example.com/api/v1/custom-fields/reorder \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
        "customFieldIds": [
          "019fee0f-c188-7a05-9d2e-3b7c60f4ad81",
          "019fee0f-9a33-7d41-b8c7-6f0e2a5b91d4"
        ]
      }'
```

| Status | Code                | Cause                                                                              |
| ------ | ------------------- | ---------------------------------------------------------------------------------- |
| `200`  | —                   |                                                                                    |
| `400`  | `validation_failed` | An id that is not a UUID, or more than 50 ids                                      |
| `401`  | `unauthenticated`   | No session                                                                         |
| `403`  | `forbidden`         | No `tenant:settings`                                                               |
| `409`  | `conflict`          | Not exactly the tenant's current set — a repeated id, a missing one, a foreign one |

**The whole set, not a delta**, and that buys optimistic concurrency for free: a submitted
set that is not exactly the current one means another admin added or deleted a field since
this client loaded the page, and the answer is `conflict` rather than a silent partial
reorder. A set that repeats one id and omits another has the right length and the wrong
contents, and is refused the same way.

This is the only way to change `position`. `POST` assigns it server-side and `PATCH` does not
accept it, so "move this field up" is atomic rather than a client-computed renumbering raced
by the next admin.

## Auditing

Definition writes record an `audit_logs` row — `custom_field.created`, `.updated`,
`.deleted` and `.reordered`, with `target_type = 'custom_field'`. Defining the shape of the
tenant's contact record is tenant configuration, the same class of change as a team
membership edit, which ADR 0004 already audits.

**Metadata carries the field's `key`, `label` and `type` — never a value any contact holds
under it.** The table is exported for compliance review rather than being a place to discover
a customer's data.

A reorder names the field that now renders first as its `target_id`, because
`audit_logs.target_id` is not nullable and the operation is on the list rather than on one
field. A reorder of an empty set uses the all-zero UUID.

**Contact and tag writes are not audited.** Editing a customer's record and coining a label
are ordinary agent work on tenant data, not configuration changes; `updated_at` on the row is
the record that they happened.

## Security and isolation

- Every path runs through `TenantPrisma`, so every statement carries the `app.tenant_id` GUC
  and is filtered by TAR-48's row-level security. The services take no tenant id from a
  caller — there is no parameter for one — which is what makes "no cross-tenant read or write
  under any role" a property of the wiring rather than of remembering to add a filter.
- **A tag from another tenant cannot be attached to a contact.** The composite foreign key
  `(tenant_id, tag_id)` on `contact_tags` is what actually refuses it; row-level security
  cannot, because the join row carries our own `tenant_id` and satisfies the policy.
  `assertTagsExist` runs first so the attempt is a `validation_failed` naming the ids rather
  than a `500` from a constraint.
- **The delete strip is a raw `UPDATE` bounded by an explicit `tenant_id` predicate as well
  as by the policy**, so it is row-level security _and_ the predicate holding the boundary,
  not Prisma's argument rewriting.
- **A record the caller may not see is `not_found`, never `forbidden`.** Another tenant's
  contact is already invisible, and a `403` there would confirm the id exists somewhere.
- **A bad _reference_ is `validation_failed` naming the field, not `not_found`.** The missing
  thing is not the resource being addressed, and the server genuinely cannot tell another
  tenant's tag from a tag that never existed. That indistinguishability is the point.

## Known gaps

Open at the time of writing, all filed:

- **Two concurrent `PATCH`es to different custom-field keys on the same contact can lose one
  write** (TAR-530). `update()` reads the stored map, merges in JavaScript, and writes the
  whole computed map back; `$tenantTransaction` runs at PostgreSQL's default READ COMMITTED,
  so the read and the write are not atomic against a concurrent transaction. Both requests
  answer `200`. The merge fixes the _form-did-not-load-every-key_ half of the problem, not
  the concurrency half. Live on `main`; the fix is in review.
- **The console offers no way to reorder definitions.** `POST /custom-fields/reorder` is
  implemented and tested, and nothing in `apps/web` calls it — the admin table renders in
  `position` order with no drag handle, deliberately, rather than shipping a control that
  could not call the endpoint. API consumers have the route; console admins get creation
  order.
- **The console reads only the first 100 tags** and there is no server-side cap on tags, so a
  tenant past 100 gets a partial vocabulary. The console says so on screen rather than
  mislabelling a tag as deleted, but the underlying asymmetry — definitions are capped, tags
  are not — is unresolved.
- **`is_not_set` on a `contact_attribute` condition does not match a contact that has never
  had a custom field written** (TAR-370). Contacts auto-created from a first inbound message
  have a null `custom_fields` column, and every operator is false against it. Detail in
  [the assignment rules reference](assignment-rules-api.md#known-gaps).

## Deviations from amendment 10

Two, both additive, and both discovered when the surface was first implemented:

1. **`POST /api/v1/tags` has a published input shape.** 0002 published the route and its
   response and never an input shape, because nothing implemented it. `TagCreateInputSchema`
   and `TagListQuerySchema` are that shape, and no existing caller reads either.
2. **The delete strip carries two guards the amendment's SQL leaves implicit** —
   `jsonb_exists` and the `jsonb_typeof` object check, both described under
   [`DELETE`](#delete-apiv1custom-fieldsid).

> **TODO(author):** the comment on `packages/contracts/src/contacts.ts:37` still says
> `tags.name` is `citext`. It is plain `text` (`apps/api/prisma/schema.prisma`), and the
> case-insensitivity comes entirely from `mode: 'insensitive'` in the query. TAR-530 owns
> that correction; this page documents the actual mechanism rather than the comment.

## Verification

Everything below was run on 2026-08-16, against `main` at `e48d3b2` — the commit this page
was written from, with both TAR-479 (#158) and TAR-480 (#157) merged.

- **Every status code, error code and isolation claim on this page**:
  `apps/api/src/contacts/contacts-tenant-isolation.int-spec.ts`, run against a real
  PostgreSQL and the real request pipeline over two tenants whose fixtures are identical in
  shape — same tag name `VIP`, same field key `tier`, same stored value `gold`, so a leak is
  visible rather than plausible — **33 tests, all passing**.
- **Merge semantics, per-type validation, the reserved-key list and the mappers**:
  `pnpm --filter @whatsappcrm/api exec jest src/contacts src/tags` — **34 tests, 3 suites,
  all passing**.
- **Every JSON body on this page** parses against its schema in
  `packages/contracts/src/contacts.ts`.

The `curl` invocations show the request shape against a deployed host. They were not
themselves typed at a terminal: the calls that were run are the integration spec's, issued
through `supertest` against its own two fixture hosts, and that is where every status code
above comes from.
