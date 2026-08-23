# Reqta alignment: interaction states, admin console and signup (TAR-807)

- **Status**: Accepted, pending one reconciliation — see "Part 4"
- **Date**: 2026-08-23
- **Issue**: TAR-807, under TAR-800
- **Author**: UI/UX Designer
- **Builds on**: [0001 — Visual design language](0001-visual-design-language.md)
- **Consumed by**: TAR-803 (tenant console alignment), TAR-804 (platform-admin
  console), TAR-805 (public self-signup UI)

**Reader: the engineer building one of those three.** It assumes 0001 and does not
repeat it. Where 0001 already rules something, this document cites it rather than
restating it; where it says nothing, this document decides. If the two ever disagree,
0001 wins and this file is stale — fix it in the same pull request.

This is a **specification, not an inspiration board**. Every section names the layout,
the tokens, the states and the motion. Nothing here should require an implementer to
choose a colour, a duration or a spacing step.

## What this is measured against, and the one thing it is not

TAR-800 fixes the pixel-level source of truth as `Reqta CRM.dc.html` and
`Reqta Admin.dc.html` in the claude.ai/design project "Modular SaaS CRM design".

**Those two files were not reachable when this spec was written.** They were attached to
TAR-801 on 2026-08-23 and ported there, so the value gap this section describes is closed —
see 0001's "What TAR-801 ported, and what it did not", and Part 4.1 for what is left. This
spec was written against:

1. **0001's token layer and component vocabulary**, which is the executable half of the
   design system and is in the repository, and
2. **the actual API contracts and controllers**, read directly, which is what makes
   Part 2 buildable at all.

That split is deliberate, and it is safe, because of what each of the three build tasks
actually needs from the reference:

- **Values** — the specific greens, the specific radii — come from the reference through
  **TAR-801**, which is porting them into `primitives.css`/`semantic.css` right now. This
  spec never states a value; it states a **role**. When TAR-801 re-points
  `--color-accent`, every rule here follows without an edit.
- **Structure and states** — which control appears where, what it does on hover, what the
  error looks like, what the empty screen says — is precisely what the two static mocks
  **do not contain**, which is the reason TAR-807 exists at all (see the Project Manager's
  2026-08-23 note on TAR-800).

So the reference's absence costs this spec its **value** layer, which it was never going
to own, and costs it nothing in the **structural** layer, which is all of it. Part 4 is
the check-in that closes the loop once TAR-801 lands.

Two consequences an implementer should hold onto:

- **Never hardcode a value to "match the mock".** If a screen appears to need one, that is
  a token TAR-801 owes it — raise it, do not improvise it. This is 0001's rule, and it is
  the whole reason the gap above is survivable.
- **Where this spec names a layout the reference may have drawn differently**, it says so
  inline and gives the reason. Those are the points to check first in Part 4.

---

# Part 0 — Shared foundation

Everything in Parts 1–3 is built out of this part. Read it once.

## 0.1 The state matrix

Every interactive control answers **seven** questions. A control that answers fewer is not
finished, and "the reference only drew one of them" is not a reason — a static mock has no
hover.

| State           | When                                      | Rule                                                                                    |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `default`       | Resting                                   | 0001's surface and border roles. Nothing else                                           |
| `hover`         | Pointer over it, `@media (hover: hover)`  | A **ground** change only — never a border, size or shadow change. `--duration-fast`     |
| `focus-visible` | Keyboard focus                            | The global ring, `base.css:89`. Two components override it and no third may — see 0.4   |
| `active`        | Pointer down / `:active`                  | One step past hover. **Currently missing app-wide — see 1.7**                           |
| `disabled`      | The control cannot be used at all         | `--color-surface-sunken` ground, `--color-on-surface-muted` text, `cursor: not-allowed` |
| `error`         | The control's own value is rejected       | `aria-invalid='true'` drives it. Border `--color-danger`, and see 1.1 for what else     |
| `loading`       | The reader pressed it and it is in flight | `Button`'s `isPending`. Never a page-level spinner for a control-level wait             |

Three rules bind all seven:

- **`hover` is never the only carrier and never the strongest.** A row that changes ground
  on hover and a row that is `selected` must not be the same colour;
  `--color-surface-selected` is a distinct role for exactly this reason.
- **`disabled` is a last resort.** 0001: "an action a role cannot perform is not offered."
  Disable a control only when the reader can make it usable by acting on this same screen —
  an unmet form field, a menu entry that needs a selection. Otherwise omit it and say why
  in a `Notice`.
- **`error` is never colour alone.** Every error state pairs the danger border with a
  message wired through `Field`'s `error` prop, which is what supplies `aria-invalid` and
  `aria-describedby`. A red border with no sentence is a control nobody can fix.

## 0.2 Motion vocabulary

0001 fixes the durations and both easings. This spec fixes **which motion belongs to which
relationship**, because "the panel appears" and "the panel came from the button you
pressed" are the same code with different numbers.

| Relationship                             | Duration            | Easing              | What moves                                       |
| ---------------------------------------- | ------------------- | ------------------- | ------------------------------------------------ |
| A colour changing under a pointer        | `--duration-fast`   | `--easing-standard` | `background-color`, `color`, `border-color`      |
| Something arriving from a control's edge | `--duration-fast`   | `--easing-enter`    | `opacity` + a 4px `translate` toward its trigger |
| A panel entering the screen              | `--duration-medium` | `--easing-enter`    | `opacity` + `translate`                          |
| A panel leaving                          | `--duration-fast`   | **`--easing-exit`** | The inverse. Exits are faster than entrances     |
| A scrim                                  | `--duration-fast`   | `--easing-standard` | `opacity` only                                   |
| Content replacing a skeleton             | `--duration-fast`   | `--easing-enter`    | `opacity` (0001: the incoming half only)         |
| A row appearing or leaving a list        | `--duration-fast`   | `--easing-enter`    | `opacity`. Never height — the list would jump    |

**Exits are faster than entrances, and this is why.** An entrance is telling the reader
where something came from and is worth the time; an exit is the reader having already
decided, and a slow one is the interface arguing. `--easing-exit` does not exist yet — it
is the one motion token this spec asks TAR-801 for (0.3).

**Never animate** `width`, `height`, `top`/`left`, or anything that reflows. `opacity`,
`translate`, `scale` and colour only.

**Reduced motion is already handled by the token layer** (0001; `semantic.css:395`). No
component branches on the preference. One rule on top of it, already precedent in
`StateLayout`: a component that fades _and moves_ drops the movement outright under the
preference rather than moving it in 1ms.

## 0.3 What this spec needs from TAR-801

Everything below is expressed in roles that exist today. Four are missing. **These are the
only additions this spec asks for**, and each is a role — not a value:

| Token                           | Why nothing existing covers it                                                                                                                    | Where used                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `--easing-exit`                 | Only `--easing-standard` and `--easing-enter` (decelerate) exist. An accelerating curve is what a dismissal needs; `standard` reads as hesitation | Menus, modals, tooltips, toasts |
| `--color-surface-active`        | There is `-hover` and `-selected` but no pressed ground. Reusing `-selected` makes a press look like a selection that did not stick               | Every pressed control — see 1.7 |
| `--color-surface-sunken-active` | Its counterpart, for the same reason 0001 needs two hover roles: a row on a sunken column has no surface of its own                               | Conversation rows, list rows    |
| `--size-tooltip`                | `--size-menu` is a label-plus-a-count width; a tooltip is a short phrase and wants a tighter cap than `--measure-body`                            | The new `Tooltip` — see 1.5     |

**All four landed under exactly these names in TAR-801** (2026-08-23), so there is nothing
for Part 4.1 to reconcile on this table. `--color-surface-active` and
`--color-surface-sunken-active` are a step past hover in the direction hover already moved,
`--easing-exit` is `cubic-bezier(0.4, 0, 1, 1)`, and `--size-tooltip` is 11rem;
`tokens.test.ts` asserts the properties each was asked for rather than the values. Nothing else in this
spec should need a new token; if a screen appears to, raise it rather than adding one —
that is 0001's rule and this document is not an exception to it.

## 0.4 The two focus-ring overrides, and why there is no third

0001 permits exactly two: `--color-focus-ring-on-rail` (the rail stays dark while the theme
flips around it) and `Button variant="dangerQuiet"` (green means "action", and that control
is not that).

**The admin console does not get a third.** Its shell is the same rail, so it inherits the
rail override. Nothing in Parts 1–3 introduces one.

---

# Part 1 — TAR-803: interactive control fidelity

TAR-800 asks for "full component fidelity, not just top-level palette". This part is the
list of what is actually missing today, control by control, measured by reading each
module. It is deliberately a **delta**, not a re-specification: most of these components
are close, and the work is a handful of states each rather than a rewrite.

**Scope note.** These are shared `components/ui/` components. Fixing them once fixes every
screen in TAR-803's list — dashboard, inbox, contacts, tickets, tags, campaigns, WhatsApp,
billing/invoices, team, settings. Do not fix them per screen.

## 1.1 Text input and textarea — `Control.module.css`

| State           | Today                                        | Spec                                                                                                                                           |
| --------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`       | `--color-surface` on `--color-border-strong` | Unchanged                                                                                                                                      |
| `hover`         | **Nothing**                                  | **Add.** `border-color: --color-on-surface-muted`. Ground unchanged — a text field's ground is the writing surface and must not flicker        |
| `focus-visible` | Global ring                                  | Unchanged                                                                                                                                      |
| `active`        | n/a                                          | None. A text field has no pressed state; the caret is the feedback                                                                             |
| `disabled`      | Sunken ground, muted text, `not-allowed`     | Unchanged                                                                                                                                      |
| `error`         | `border-color: --color-danger` **only**      | **Extend.** Keep the border; add `background: --color-danger-subtle`. A recoloured hairline is invisible at a glance on a form of eight fields |
| `loading`       | n/a                                          | Fields stay editable while a settings form saves (0001); they are disabled while a signed-out form submits (0001, and Part 3 relies on it)     |

Placeholder stays `--color-on-surface-muted` — never `-subtle`, which is a 2.6:1
decoration role and fails AA outright.

**The error ground is measured, not assumed.** `--color-danger-subtle` behind
`--color-on-surface` must clear 4.5:1 in both themes, and the danger border against it must
clear 3:1 (SC 1.4.11). Add both pairs to `tokens.test.ts` alongside the chip and row-action
pairs already asserted there — if either fails, drop the tint and thicken the border
instead. Do not ship the tint on an unmeasured pair.

## 1.2 Select — `Select.module.css` + `Control.module.css`

`Select` is the native `<select>` under `appearance: none` with this app's chevron drawn
back. Keep it that way — 0001's "No browser-default control chrome" rule is about the
platform's _painting_, never its keyboard model.

| State           | Today                                                 | Spec                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`       | Inherits `.control`, chevron muted                    | Unchanged                                                                                                                                                                                 |
| `hover`         | `--color-surface-hover` ground                        | Keep. **Add** the border change from 1.1, so a select and an input hover alike                                                                                                            |
| `focus-visible` | Global ring on the native element                     | Unchanged                                                                                                                                                                                 |
| `active`        | **Nothing**                                           | **Add** `--color-surface-active` while the picker is open. The native picker exposes no `[aria-expanded]`, so this is `:active` only — accepted: it is reinforcement, not the only signal |
| `disabled`      | `cursor: not-allowed`, `.chevron` dimmed via `:has()` | Unchanged                                                                                                                                                                                 |
| `error`         | **Chevron unaffected**                                | **Add** `.wrapper:has(select[aria-invalid='true']) .chevron { color: --color-danger }`. Today the box turns red and the glyph inside it stays grey, which reads as a rendering bug        |
| `loading`       | n/a                                                   | A select whose options are still loading renders **disabled with a single option naming the group** — never an empty select, which reads as "no options exist"                            |

`variant="filter"` keeps its `--size-menu` cap. Its empty option is named for the group
("All roles", never "All") — 0001's filter-row rule, and the reason a filter select needs
no label above it.

## 1.3 Menus — `MenuButton.module.css`

The component with the most missing, and the one TAR-800 names first.

**Trigger:**

| State           | Today                                                 | Spec                                                                                                                                                                          |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`       | Three variants: bare, `control`, `icon`               | Unchanged                                                                                                                                                                     |
| `hover`         | Ground change, `--duration-fast`, `--easing-standard` | Unchanged                                                                                                                                                                     |
| `focus-visible` | Global ring                                           | Unchanged                                                                                                                                                                     |
| `active`        | **Nothing**                                           | **Add** `--color-surface-active`, all three variants                                                                                                                          |
| `open`          | `[aria-expanded='true']` ground                       | Unchanged, but it must be **visually distinct from hover** — verify side by side rather than assume; `control` and `icon` currently set the two to grounds that need checking |
| `disabled`      | **Nothing**                                           | **Add.** Muted text, `not-allowed`, and the panel cannot open. A trigger with no entries behind it is **not rendered at all**, per 0001's quick-create rule                   |

**Panel:**

| Aspect           | Today                                                                 | Spec                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface          | `--color-surface-raised`, `--shadow-overlay`, `--radius-lg`, hairline | Unchanged                                                                                                                                                                                                                                                                                                                                       |
| Motion           | **None — it appears instantly**                                       | **Add.** Enter: `opacity` 0→1 and `translate` 4px→0 **toward the trigger** (a panel below its trigger enters from 4px above), `--duration-fast`/`--easing-enter`. Exit: the inverse at `--duration-fast`/`--easing-exit`. Use `@starting-style` + `allow-discrete` as `Modal` already does, and accept the instant appearance where unsupported |
| Transform origin | n/a                                                                   | The trigger's edge. This is the point of the motion: it says _this panel belongs to that button_, which is the one thing a plain fade cannot say                                                                                                                                                                                                |
| Off-screen       | `--menu-shift`, measured after open                                   | Unchanged, and it already works under `dir="rtl"` — do not "fix" it for TAR-806                                                                                                                                                                                                                                                                 |

**Menu entries:**

| State           | Today                                 | Spec                                                                                                                                                                                                |
| --------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`       | `--size-touch-target` tall, `body-sm` | Unchanged                                                                                                                                                                                           |
| `hover`         | `--color-surface-hover`               | Unchanged                                                                                                                                                                                           |
| `focus-visible` | Global ring                           | Unchanged. Keyboard focus and pointer hover must land on the **same** ground, so arrowing through reads as the same motion as moving a mouse                                                        |
| `active`        | **Nothing**                           | **Add** `--color-surface-active`                                                                                                                                                                    |
| `disabled`      | **Nothing**                           | **Add.** `--color-on-surface-muted`, no hover ground, `aria-disabled='true'` — kept in the tab order, so a screen-reader user can find out it is there and why                                      |
| `destructive`   | Ruled in 0001, unenforced in CSS      | `--color-danger` text, below a separator, **last**. Hover ground `--color-danger-subtle`, matching `Button variant="dangerQuiet"`                                                                   |
| `selected`      | n/a                                   | Where a menu carries the current value (the inbox's sort), the entry takes `--color-surface-selected` and `aria-current`. Never a tick glyph alone — a glyph is decoration until something names it |

## 1.4 Modals — `Modal.module.css`, `FormDialog`

| Aspect         | Today                                              | Spec                                                                                                                                                                |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scrim          | `::backdrop`                                       | `--color-scrim`, fading `--duration-fast`/`--easing-standard` — **faster than the panel**, so the room dims before the dialog lands rather than with it             |
| Panel enter    | Opacity only, `--duration-medium`/`--easing-enter` | **Extend.** Add `translate: 0 8px → 0` and `scale: 0.98 → 1`. Opacity alone is a dialog that materialises; a dialog should arrive                                   |
| Panel exit     | Same duration as enter                             | `--duration-fast`/`--easing-exit`, the inverse                                                                                                                      |
| Reduced motion | Tokens flatten the durations                       | Additionally drop the `translate`/`scale` outright, per 0.2                                                                                                         |
| Focus on open  | Handled                                            | First **interactive** element, or the panel itself where the first element is prose                                                                                 |
| Focus on close | Handled                                            | The trigger. Where the trigger's row is gone — a delete just confirmed — the `<main>` landmark, which is 0001's ruled fallback anchor                               |
| Escape         | Native `<dialog>`                                  | Closes. **A dialog with unsaved input confirms before discarding** — one nested `FormDialog`, never a browser `confirm()`                                           |
| Scrim click    | —                                                  | Closes a dialog that is a **view**. Does **not** close one that is a **form** — an accidental click off a half-filled form is the reader's work destroyed by a miss |
| Submitting     | `Button` pending                                   | The submit takes the pending state; the fields stay editable (0001) **except** on a signed-out screen (Part 3)                                                      |
| Failure        | —                                                  | `FormError` **inside** the dialog, above the footer. Never a toast behind a modal, which is a message the reader is prevented from reaching                         |

`FormDialog`'s confirmation copy is already ruled by 0001, and Part 2 leans on it hard:
name the subject ("Suspend Northwind Support?", never "Are you sure?"), repeat the verb on
the submit, `submitVariant="danger"` for the irreversible ones.

## 1.5 Tooltips — a new component

**There is no tooltip in this product today.** `InfoPopover` is a click-triggered popover
built on `MenuButton`'s `icon` variant; the only other thing resembling a tooltip is a
native `title` on the collapsed rail (`NavLinkList.tsx`) and on truncated table cells.
TAR-800 names tooltips explicitly, so this is a genuine gap and the one new component this
spec adds.

**The rule that decides which of the three to use — apply it before building anything:**

| The need                                                         | Use           |
| ---------------------------------------------------------------- | ------------- |
| An icon-only control's name                                      | `Tooltip`     |
| The full text of something visibly truncated                     | `Tooltip`     |
| A sentence or more explaining a figure, a setting, a methodology | `InfoPopover` |
| Anything a reader must be able to select, copy, or click inside  | `InfoPopover` |

A tooltip holds **a phrase**. The moment it holds a sentence with a link in it, it is a
popover that has been drawn wrong — a hover surface a pointer cannot travel to is a surface
a pointer user cannot read.

**Spec:**

- **Structure.** The trigger is the control itself. The tip is `--color-surface-raised`,
  hairline, `--radius-md`, `--shadow-overlay`, `--space-2` padding, `--font-size-caption`
  in `--color-on-surface`, capped at `--size-tooltip` (0.3), `z-index: --z-nav`.
- **Not light-on-dark.** An inverted tooltip is a second surface vocabulary for one
  component, and it is the thing that will not survive TAR-29's per-tenant themes.
- **Placement.** Block-end of the trigger by default, flipping to block-start when it would
  leave the viewport, nudged inline the same way `MenuButton` already does with
  `--menu-shift` — reuse that measurement, do not write a second one.
- **Delay.** 500ms before the first tooltip in a group appears; **0ms** for the next one
  while the group is still warm, so scanning a row of icon buttons does not stutter.
  Dismiss immediately on pointer-out, Escape, scroll, or the trigger being pressed.
- **Motion.** Enter `opacity` + 4px `translate` toward the trigger,
  `--duration-fast`/`--easing-enter`. Exit `--duration-fast`/`--easing-exit`.
- **Keyboard.** Appears on `:focus-visible` with **no delay** and stays until blur or
  Escape. A tooltip that only answers to a pointer is a label a keyboard user never gets.
- **Touch.** No hover exists. An icon-only control on touch must therefore not depend on a
  tooltip for its name — the accessible name is on the control, always, and the tooltip is
  the _visible_ spelling of it. This is the rule that keeps it honest.
- **Semantics.** `role="tooltip"`, wired with `aria-describedby` when it repeats a name the
  control already has, and `aria-labelledby` when it _is_ the name. Never both.
- **States.** A tooltip has no hover, focus, active, disabled or error state of its own — it
  is not a control, and it must never contain one.

**Migrate the two `title` attributes as you go.** The collapsed rail's label becomes a
`Tooltip`. The truncated table cell **keeps** its `title` as well, because that one is
`--measure-cell`'s overflow contract and pointer users expect the native behaviour there
(0001, TAR-727).

## 1.6 Switch, Checkbox, Slider, DateRangeField, SearchField

These are the newest controls and 0001 measured them properly (its SC 1.4.11 table). They
need **two** things, not a pass:

- **`active`.** None of them has a pressed state. Switch: the knob takes a 1px inset shadow
  while held. Checkbox: `--color-surface-active` ground. Slider: the knob's ring thickens by
  1px while dragging — never a size change, which moves the target under the pointer.
- **`error`.** `Checkbox`/`CheckboxGroup` and `Slider` have no invalid state. Both take the
  `Field`-driven `aria-invalid` and render `--color-danger` on their border/ring. `Switch`
  does **not** get one — a live setting that failed to save is a `FormError` above the form
  (0001), not a red switch, because the switch has already flipped back.

`SearchField` and `DateRangeField` inherit 1.1 and 1.2 and need nothing else.

## 1.7 The state the whole app is missing: `active`

`Button.module.css` has `hover`, `focus-visible`, `disabled`, `pending` and `unavailable`.
It has **no `:active`**. Neither does any other control. Every state table above asks for
one, and the reason it is called out separately is that it is one change in one place plus
two tokens (0.3), not eleven separate pieces of work:

| Variant       | Pressed ground                           |
| ------------- | ---------------------------------------- |
| `primary`     | One step past `--color-accent-hover`     |
| `secondary`   | `--color-surface-active`                 |
| `ghost`       | `--color-surface-active`                 |
| `danger`      | One step past `--color-danger-hover`     |
| `dangerQuiet` | `--color-danger-subtle`, one step darker |

"One step past" is a primitive TAR-801 either ports or does not; where it has not, the
existing hover value is reused and the press is carried by the `scale` below rather than by
colour. Do not invent a primitive here.

Every pressed control also takes `scale: 0.98` for the duration of the press,
`--duration-instant` in, `--duration-fast`/`--easing-exit` out. This is the cheapest thing
on this list and the one a reader feels most — it is the difference between a button and a
picture of a button.

**Excluded**: text inputs and textareas (1.1), links (the navigation is the feedback), and
anything inside a `DataTable` row that is not itself a button.

## 1.8 Rows, tabs and pills

- **Table and list rows.** A row with an action is `--color-surface-hover` or
  `--color-surface-sunken-hover` — match the role to the surface underneath, not to the
  component (0001, TAR-517). **A row with no action gets no hover at all**, which is the
  same rule read the other way: feedback that leads nowhere is a promise the row breaks.
  Pressed: the `-active` counterpart. Selected: `--color-surface-selected`, which must stay
  distinguishable from hover — check the pair, do not assume it.
- **Tabs.** The current tab is `--color-accent` (0001's "this is where you are"). Hover on a
  non-current tab is a ground change only; the indicator does **not** slide to follow a
  pointer. It **does** animate between selections — `translate`/`scale` on the indicator,
  `--duration-medium`/`--easing-standard` — because that motion says the two tabs are the
  same control.
- **FilterPills / ActiveFilterChips.** On is `--color-accent-subtle` +
  `--color-on-accent-subtle`. Each chip's clear (×) is its own focus stop with its own
  accessible name naming the filter it clears ("Clear priority: high"), never "Clear".
  Removing a chip fades the chip at `--duration-fast`; the row does not animate its reflow.

## 1.9 Screen-level notes

Most of TAR-803 is "apply the tokens and the components above". Four screens carry
something the component layer cannot give them:

- **Inbox.** The thread column and conversation list are the densest surface in the product
  and 0001 rules them in detail (its "The inbox" section). Do not restyle them from the
  reference — restyle them from 0001, and treat the reference as confirmation. The thread
  column's own hover/selected roles are the `-sunken-*` family, per TAR-517.
- **Dashboard.** `--font-size-metric` belongs to a metric tile's figure and to nothing else.
  A reference mock that uses a large number decoratively elsewhere is not a reason to reach
  for it.
- **Billing / invoices.** The invoice table is a `DataTable` with a figures column — 0001's
  "Figures in a table" rules the alignment and the numerals. It is not a bespoke layout.
- **Settings.** Every settings screen adopts `SettingsForm` when it next changes (0001).
  TAR-803 **is** that change for the screens it touches — do not restyle a settings screen
  and leave it in the single-column layout.

**Every screen in TAR-803's list must ship its empty, loading and error states**, not just
its populated one. 0001's "Every state" section is the anatomy; the only new rule here is
that a **restyle is not allowed to skip them** on the grounds that they were not in the
reference. They were not in the reference because the reference has no data layer, which is
not a design decision.

---

# Part 2 — TAR-804: the platform-admin console

## 2.0 Read this before drawing anything: what the API actually serves

`Reqta Admin.dc.html` is an operator console for a product with a billing warehouse behind
it. **This platform's admin API is much smaller than that.** Reading every admin controller
and contract in the repository, here is the complete surface:

| Route                                                  | Method | Returns / does                                                                 |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------ |
| `/v1/admin/tenants`                                    | POST   | Provision. `201` created / `200` already existed → `ProvisionedTenantResponse` |
| `/v1/admin/tenants/{slug}/deactivate`                  | POST   | Suspend, keeping data → `DeactivatedTenantResponse`                            |
| `/v1/admin/tenants/{slug}/reactivate`                  | POST   | → `active`, returns `AdminTenantLifecycleResponse`                             |
| `/v1/admin/tenants/{slug}/cancel`                      | POST   | → `cancelled`, with `reason`                                                   |
| `/v1/admin/tenants/{slug}/delete`                      | POST   | Schedule, or `force` to expedite the purge clock                               |
| `/v1/admin/tenants/{slug}/lifecycle`                   | GET    | Cursor page of `AdminTenantLifecycleEvent` — **this is the audit log**         |
| `/v1/admin/domains?status=verified\|live`              | GET    | `AdminPendingDomain[]` — the domain activation queue                           |
| `/v1/admin/tenants/{slug}/domains/{hostname}/activate` | POST   | `204`                                                                          |
| `…/deactivate`                                         | POST   | `204`                                                                          |
| `/v1/admin/webhook-events/{id}/replay`                 | POST   | Reset a parked event → `AdminWebhookEventReplayResponse`                       |
| `/v1/admin/tenants/{slug}/whatsapp/business-accounts`  | POST   | Attach a WABA on a tenant's behalf                                             |
| `…/business-accounts/{wabaId}/template-sync`           | POST   | Sync templates                                                                 |

**Five things the reference shows that this API cannot serve.** These are not design
decisions to work around quietly — each is flagged to the Architect on TAR-804, and this
spec draws the screen that is buildable today:

| Gap                                                          | Evidence                                                                                                                                                                                                  | What this spec draws instead                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **No tenant list.** There is no `GET /v1/admin/tenants`      | Only `POST` exists on the collection. Confirmed across `admin-tenants.controller.ts` and `packages/contracts/src/admin.ts`                                                                                | 2.3 — a **slug-addressed console**, plus the domain queue as the one real cross-tenant list      |
| **No tenant detail read.** No `GET /v1/admin/tenants/{slug}` | The only per-tenant `GET` is `…/lifecycle`                                                                                                                                                                | 2.4 — detail assembled from `…/lifecycle` and from whatever a write just returned                |
| **No webhook-event list.** Replay is by id only              | `admin-webhook-events.controller.ts` has exactly one route, and its own comment says it "is deliberately not the beginning of a webhook browser" — TAR-67's README gives the operator a SQL query instead | 2.9 — a **replay-by-id form**, not a queue                                                       |
| **No plan, usage or MRR, cross-tenant**                      | `billing.controller.ts` is `path: 'billing'`, inside the tenant pipeline. `usage.ts` is tenant-scoped. `mrr` appears nowhere in the repository                                                            | 2.6 — plan/usage is **not built**; tenant detail states what it does know (status and its dates) |
| **No operator identity.** Auth is a shared bearer token      | `PlatformAdminGuard`: `PLATFORM_ADMIN_TOKEN` holds `label:secret` entries. No session, no login endpoint, no per-route authorisation. Its own comment names this as the thing to replace                  | 2.2 — a **credential screen**, not a sign-in page, and it says so                                |

TAR-804's acceptance criteria name two of these directly ("list tenants", "plan/usage").
**They cannot be met against the API as it stands.** That is a Product Owner and Architect
conversation, not something to resolve by inventing an endpoint or a metric — TAR-800 itself
rules that out ("if the design implies an admin action with no API behind it, flag it rather
than silently building both halves"). Part 2 below is drawn so that **adding
`GET /v1/admin/tenants` later fills a slot this layout already has**, rather than reshaping
the screen.

## 2.1 The shell

`apps/admin` is its own Next.js app and its own deployment. It **shares the token layer**
with `apps/web` — TAR-801's output — and reuses `components/ui/` wholesale. It does not
reuse `apps/web`'s feature folders.

The frame is 0001's console frame, unchanged: rail, bar, canvas, `AppShell`'s geometry. An
operator console that invents a second frame is a second design system.

**Three deliberate differences, and no others:**

1. **The rail's destinations are Tenants, Domains, Webhooks.** In that order, and each is
   added by the story that builds its route — an entry ahead of its route is a link to a 404
   (0001).
2. **The bar carries a persistent environment marker**: a `Badge` naming the deployment
   (`Production`, `Staging`), tone `danger` for production and `neutral` elsewhere. This is
   the one thing this console has that the tenant console does not, and it earns its place —
   every write on this surface is cross-tenant and irreversible, and "which environment am I
   in" is the question behind every operator incident. The value comes from the app's own
   build-time config, never from an API.
3. **No theme toggle, no account menu, no search.** There is no account (2.2), a search
   would have nothing to search (2.0), and 0001's rule holds: nothing in the shell for a
   feature the app does not have. The bar carries the environment badge and the
   "Forget credential" control (2.2), and that is all.

**Every screen in this app is `noindex`.** Set `robots` on the root layout, the way
`(auth)/layout.tsx` already does.

## 2.2 Getting in — a credential screen, not a sign-in page

`PlatformAdminGuard` authenticates a **shared bearer token**. There is no user, no session,
no password, no "forgot". Drawing an email-and-password form here would be a lie about what
the credential is, and would train an operator to type a password into a box that wants a
secret.

**Layout.** 0001's signed-out split (`(auth)/layout.tsx`), with the brand panel carrying the
_platform's_ identity — `readBranding()` resolves a tenant from the host and there is no
tenant here, so `apps/admin` uses the platform default and never calls it.

**The form.** One `Field`, labelled `Operator token`, a `PasswordField` (it gets the reveal
control for free, and this value is worth checking before submitting), and one block submit
reading `Continue`.

**Copy, above the field**: "This console is authenticated by a shared operator credential,
not a personal account. Every action you take is recorded against the credential's label."
That sentence is not decoration — it is the only place an operator learns that `actorLabel`
on the audit trail is a credential and not them.

| State        | Treatment                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`    | As above                                                                                                                                                                                     |
| `loading`    | `AuthForm`'s pending: fields disabled, submit reads `Checking…`                                                                                                                              |
| `error`      | `FormError` above the action: "That credential was refused." **Never** distinguish "no token configured" from "wrong token" — the guard does not, deliberately, and neither does this screen |
| `rate-limit` | The guard does not throttle. If a `429` ever arrives, render it as the generic refusal — do not invent copy for a path that does not exist yet                                               |

**Where the token lives.** A design constraint, stated because it changes the screen: it
must **not** be persisted to `localStorage`. In-memory for the tab, with an `httpOnly`
cookie set by the admin app's own server route as the durable option — an Architect
decision, flagged on TAR-804. Whichever lands, the shell carries a **Forget credential**
control in the bar, and it is the reason that control exists.

**On refusal mid-session** (the token was rotated under the operator), every screen shows
the same thing: an `ErrorState` with `role="alert"`, "This credential is no longer
accepted", and one action back to the credential screen. Never a silent redirect — an
operator mid-incident needs to know the credential changed, not to wonder why they are back
at the front door.

## 2.3 Tenants

**This is the screen the missing `GET /v1/admin/tenants` bites.** It is drawn in two
regions, and the second is a real list today.

### Region 1 — Open a tenant

A `SectionCard` at the top of the page: a `SearchField` labelled `Tenant slug`, and a
`Button variant="primary"` reading `Open tenant`. Submitting navigates to `/tenants/{slug}`.

The card's description says what it is: "This console addresses tenants by slug. There is no
cross-tenant tenant list yet — see the domain queue below for tenants with a domain in
flight."

**That sentence is the honest version of the gap, and it is deliberately in the product**,
not only in this document. An operator who does not know the list is missing will read the
screen as broken.

Beside it, `Button variant="secondary"` → `Provision a tenant`, opening a `FormDialog` (2.5).

| State     | Treatment                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default` | Empty field, submit disabled until the field validates against `TenantSlugSchema` — the one legitimate disabled submit here, because the reader fixes it on this screen            |
| `loading` | Submit pending, reading `Opening…`                                                                                                                                                 |
| `404`     | Inline `Field` error: "No tenant has the slug _acme_." The slug is quoted back — an operator mistypes, and a message that does not echo the input does not help them find the typo |
| `error`   | `FormError` above the action, with a retry                                                                                                                                         |

### Region 2 — The domain queue

`GET /v1/admin/domains` is the **one real cross-tenant list this API serves**, and it is
genuinely operational work. 0001's list-view pattern applies unchanged:

1. `PageHeader` — `<h1>` "Tenants", no header action (the two actions are in region 1)
2. `FilterBar` — one `Select variant="filter"`, options `Waiting to attach` (`verified`) and
   `Attached` (`live`), value in the URL
3. Queue header — the page count at the inline start; the order is a **label**, not a menu,
   because the endpoint serves one order (0001's rule)
4. `DataTable` in a `SectionCard` with `isTitleVisible={false}`

| Column   | Source       | Treatment                                                                                                                         |
| -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Tenant   | `tenantName` | `TextLink` → `/tenants/{tenantSlug}`, with `tenantSlug` as a caption beneath it                                                   |
| Hostname | `hostname`   | `--font-family-mono`, capped at `--measure-cell` (0001, TAR-727)                                                                  |
| Verified | `verifiedAt` | `RelativeTime`                                                                                                                    |
| Status   | derived      | `Badge` — `warning` "Waiting to attach" when `activatedAt` is null, else `success` "Attached". One chip; the budget is one (0001) |
| Actions  | —            | `RowActions`: `Attach` / `Detach` as `Button variant="secondary"`. Two actions, so both inline                                    |

`unstackAt="wide"` — a hostname column plus a tenant column plus two actions will not fit
40rem. **Measure it** from 320px to 1600px before settling the threshold, per TAR-727.

**Every state:**

| State                     | Treatment                                                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loading`                 | `DataTableSkeleton`, matching the column count. Never a spinner                                                                                                                                                                                                               |
| `empty` (never had any)   | `EmptyState`, icon `globe`, "No domains are waiting", "A tenant's custom domain appears here once they have proved they own it." No action — there is genuinely no next step, and this is 0001's `tone="quiet"` question answered: it is a real empty, not a resting position |
| `zero results` (filtered) | A **different** state, per 0001: "Nothing is attached yet", with an action switching the filter back to `Waiting to attach`. Sharing one string between these two is what makes a working filter look broken                                                                  |
| `error`                   | `ErrorState` with a retry, section-scoped inside `SectionErrorBoundary` — region 1 must keep working when region 2's fetch fails                                                                                                                                              |
| `partial`                 | Not applicable — the endpoint has no cursor                                                                                                                                                                                                                                   |

`Attach`/`Detach` return `204` and are **not** confirmed — they are reversible by the
control beside them, and 0001 reserves confirmation for the irreversible. On success, a
toast naming the hostname and the list refetches; on failure, an `AlertBanner tone="danger"`
above the table naming the hostname, because the row may no longer be there.

### When `GET /v1/admin/tenants` lands

It replaces **region 1 only**. Region 2 stays where it is. The tenant table it fills in is
`slug` / `name` / `status` `Badge` / `createdAt` — with the status chip using the tone map
in 2.4 — and the "open by slug" field becomes that table's `SearchField`. Build region 1 so
that swap is a component change, not a page rewrite.

## 2.4 Tenant detail — `/tenants/{slug}`

Assembled from `GET /v1/admin/tenants/{slug}/lifecycle`, which is the only per-tenant read
there is. The **newest event's `toStatus` is the tenant's current status** — a real
inference from the state machine, not a guess, and it is worth a code comment saying so,
because it is the seam that changes when a detail read lands.

**Layout** — 0001's detail-view pattern:

1. `PageHeader` — `<h1>` the tenant's name; the slug beneath in `--font-family-mono`. Header
   action: `MenuButton` labelled `Manage tenant`, holding the writes (2.5)
2. A status band — at most **two** chips (0001's detail budget):
   - the lifecycle status (tone map below)
   - **one** time-bounded chip, and only when its date is in the future: `Trial ends`,
     `Grace period ends`, or `Purges` — ranked in that order, the same "most-actionable
     first" rule as `conversation-chips.ts`. Where more than one applies, the others go in
     the detail list below rather than competing for the glance
3. `SectionCard` "Lifecycle" — a `DetailList` of every non-null date from
   `AdminTenantLifecycleResponse`: `trialEndsAt`, `gracePeriodEndsAt`, `suspendedAt`,
   `cancelledAt`, `purgeAt`, `deletedAt`. **A null date renders no row** — a list of "—" is
   a screen of absences
4. `SectionCard` "History" — the audit log (2.7)

**The status tone map.** Fix it once, here, and read it from one module the way
`conversation-chips.ts` is read — never inline in a cell:

| `TenantStatus` | Tone      | Label        |
| -------------- | --------- | ------------ |
| `created`      | `neutral` | Provisioning |
| `trialing`     | `info`    | Trialing     |
| `active`       | `success` | Active       |
| `past_due`     | `warning` | Past due     |
| `suspended`    | `danger`  | Suspended    |
| `cancelled`    | `danger`  | Cancelled    |
| `deleted`      | `neutral` | Deleted      |

`deleted` is `neutral`, not `danger`, and that is deliberate: danger marks a state that
wants an operator's attention, and a purged tenant wants nothing. `created` is the same
reasoning — the contracts note that no tenant is ever _served_ in it, so seeing it is odd
but not urgent.

**Every state:**

| State     | Treatment                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loading` | Skeleton blocks matching the real layout — header, band, two cards. Never a centred spinner (0001)                                                                                                                                                                                    |
| `404`     | `EmptyState`, "No tenant has the slug _acme_", action back to Tenants. An `ErrorState` would be wrong: nothing failed                                                                                                                                                                 |
| `error`   | `ErrorState` with retry, page-scoped — the whole screen comes from one read, so the boundary belongs at the page (0001)                                                                                                                                                               |
| `deleted` | The screen renders in full, with an `AlertBanner tone="danger"` above the header: "This tenant's data was purged on {date}. Nothing here can be undone." Every write in the `Manage tenant` menu is **omitted**, not disabled — the state machine forbids every edge out of `deleted` |

**No plan or usage section.** Not "a section reading Coming soon" — no section. A card that
promises data the platform cannot produce is the same broken promise as a notification bell
with no notifications (0001). When a cross-tenant billing read lands, it slots between
Lifecycle and History.

## 2.5 The writes

Five, all `POST`, all through `FormDialog`, all naming their subject.

| Action     | Route            | Confirm copy                                                                                                          | Submit                                  | Reversible?              |
| ---------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------ |
| Provision  | `POST …/tenants` | Not a confirmation — a form: `slug`, `name`, optional timezone and locale                                             | `Provision tenant`, `variant="primary"` | n/a                      |
| Suspend    | `…/deactivate`   | "Suspend Northwind Support? Its agents lose access on their next request, including open sessions. Its data is kept." | `Suspend tenant`, `danger`              | Yes — Reactivate         |
| Reactivate | `…/reactivate`   | "Restore access for Northwind Support?"                                                                               | `Reactivate tenant`, `primary`          | Yes                      |
| Cancel     | `…/cancel`       | "Cancel Northwind Support's subscription? It keeps access until the grace period ends, then suspends."                | `Cancel subscription`, `danger`         | Effectively — Reactivate |
| Delete     | `…/delete`       | See below — the dangerous one                                                                                         | See below                               | **No**                   |

**Provision** is the one form here, and it is a form because it takes input rather than
confirmation. Fields per `ProvisionTenantInputSchema`. Two rules it must honour:

- `slug` is validated against `TenantSlugSchema` client-side and its help text says what it
  becomes ("This becomes the tenant's address: _acme_.example.com. It cannot be changed
  later."). 0001's rule that help text explaining the _value_ belongs in `aria-describedby`
  applies.
- **`200` and `201` are different outcomes and the UI must say which.** `201` → toast
  "Provisioned Northwind Support" and navigate to the detail. `200` → the dialog stays open
  with a `Notice tone="info"`: "A tenant already exists at that slug. Nothing changed.", then
  a link to it. Treating the idempotent replay as a success is how an operator concludes they
  created something they did not.

**Cancel** takes an optional `reason`, a `Textarea`, with help text: "Recorded on the audit
trail. Never shown to the tenant." That second sentence is load-bearing — ADR 0009 makes it
a security property, and an operator who does not know it will write for the wrong audience.

**Delete** is the most dangerous control in the product and gets treated like it:

- Two modes in one dialog, **scheduled selected by default**: `Schedule deletion` (grace
  period, then suspend, then purge on the retention clock) and `Delete immediately`
  (`force: true` — straight to suspended with `purgeAt` moved to now).
- Choosing `Delete immediately` reveals a **type-to-confirm** field: the operator types the
  tenant's slug. This is the only type-to-confirm in the product and it is justified — it is
  the one action that destroys customer data on a clock the operator just shortened, and the
  API's own comment frames it as a right-to-erasure path.
- The submit is `submitVariant="danger"` and repeats the mode's verb: `Schedule deletion` or
  `Delete tenant now`. It is disabled until the confirm field matches — the reader fixes that
  on this screen, so 0.1's disabled rule permits it.
- Copy names the consequence with its date: "Northwind Support's data will be destroyed on
  {purgeAt}. This cannot be undone."

**All five, shared:**

| State     | Treatment                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loading` | Submit pending with the verb in progressive form (`Suspending…`). Fields disabled — this is a credential path in spirit, and a half-changed confirmation is worse than a locked one |
| `success` | Dialog closes, toast names the subject and the verb, the page refetches. Focus returns to the trigger, or to `<main>` if the trigger is gone (0001)                                 |
| `error`   | Dialog **stays open**, `FormError` above the footer. A dialog that closes on failure takes the reason and the half-entered `reason` field with it                                   |
| `409`     | The transition is illegal for the tenant's current state. Message names it: "Northwind Support is _cancelled_; it cannot be cancelled again." Do not render the API's raw message   |
| `404`     | The tenant went away underneath. Close the dialog, `AlertBanner tone="danger"` on the page, refetch                                                                                 |

## 2.6 Plan and usage — not built

Covered in 2.0 and 2.4. There is no cross-tenant billing or usage read, and no MRR anywhere
in the codebase. **Do not build a section for it, and do not derive one from `trialEndsAt`.**
Flagged on TAR-804 for the Architect; when a read lands it takes the slot named in 2.4.

## 2.7 Audit log

`GET /v1/admin/tenants/{slug}/lifecycle` — a cursor page of `AdminTenantLifecycleEvent`,
newest first. It renders as the "History" card on the tenant detail; it is not a separate
route, because the API has no cross-tenant audit read.

`DataTable`, default `unstackAt`:

| Column  | Source                     | Treatment                                                                                                                             |
| ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| When    | `occurredAt`               | `RelativeTime`, with the absolute value in its `title`                                                                                |
| Change  | `fromStatus` → `toStatus`  | Two `Badge`s with an arrow between, using 2.4's tone map. `fromStatus` null renders the word "Created", not an empty chip             |
| Trigger | `trigger`                  | `Badge variant="outline"` — this is metadata, not status, which is exactly what `outline` is for (0001)                               |
| Actor   | `actorType` + `actorLabel` | The label where present; otherwise the actor type in sentence case. `unattributed` renders "Backfilled" in `--color-on-surface-muted` |
| Reason  | `reason`                   | Capped at `--measure-cell`, full value in `title`. **A null reason renders nothing** — not "—"                                        |

**The `reason` column is why this endpoint exists** (ADR 0009: it is the operator's copy of
a trail the tenant also has, and `reason` is the one column the tenant's does not get). It
is not a nice-to-have column to drop on a narrow screen — if the table must lose something
when stacked, it is not this.

**Paging.** `CursorPageQuery`. The queue header says "25+ events" where a cursor is
outstanding and "6 events" where it is not — 0001's rule that the count is the _page's_,
never a total. A `Button variant="secondary"` at the foot reads `Load older`; new rows fade
in at `--duration-fast` and **the scroll position does not move**.

| State     | Treatment                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loading` | `DataTableSkeleton`                                                                                                                                                                                                              |
| `empty`   | Cannot happen — provisioning writes the first row inside the transaction that creates the tenant. Render `EmptyState` "No history recorded" anyway; an impossible state that renders nothing is a blank card nobody can diagnose |
| `error`   | `ErrorState` with retry, inside its own `SectionErrorBoundary` — the header and the lifecycle card must survive it                                                                                                               |
| `partial` | Older events failed to load: the loaded rows stay, a `Notice` above them says so with a retry (0001's partial-data rule)                                                                                                         |

## 2.8 Domains

`GET /v1/admin/domains` is already the tenant page's region 2 (2.3). A dedicated `/domains`
route is the same table without region 1 above it and with its own `PageHeader`. Build the
table once and render it in both.

## 2.9 Webhook replay — a form, not a queue

**There is no endpoint that lists webhook events.** The controller has exactly one route and
its own comment says it is "deliberately not the beginning of a webhook browser"; TAR-67
gives operators a SQL query in the README instead. A UI that presents a queue here would be
a queue with nothing to fill it.

So `/webhooks` is a single `SectionCard`:

- Description: "Reset a parked inbound event so the next sweep reprocesses it. Find the event
  id with the query in the webhooks runbook — this console has no event list." A
  `TextLink isExternal` to the runbook.
- One `Field` labelled `Webhook event id`, `--font-family-mono`, validated against `IdSchema`,
  and one `Button variant="primary"` reading `Replay event`.
- **No confirmation dialog.** A replay is a status reset, not a destruction, and the
  409-on-repeat below is a better guard than a dialog an operator learns to click through.

**Below the form, a session log** — every replay attempted in this tab, newest first, as a
`DetailList` per entry showing `id`, `provider`, `parkedError` and `replayedAt` from
`AdminWebhookEventReplayResponse`. It is in-memory and disappears on reload, and the card
says so: "This list is not saved." An operator working through a batch of ids needs to see
what they have already done, and this is the cheapest honest way to give it to them with no
list endpoint behind it.

| State     | Treatment                                                                                                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default` | Empty field, submit enabled once the id validates                                                                                                                                                                                                                                                               |
| `loading` | Submit pending, `Replaying…`                                                                                                                                                                                                                                                                                    |
| `success` | Field clears, focus returns to it (a batch is the normal case), the entry prepends to the log with a `Notice tone="success"`. **The copy must not overclaim**: "Reset for reprocessing. The sweeper collects it within its next interval." The API is explicit that `replayedAt` is not when it was reprocessed |
| `409`     | `Field` error carrying the API's own sentence, which already names the status and what to do — this is the one place to render it verbatim, because it is better than anything the UI could compose                                                                                                             |
| `404`     | `Field` error: "No stored webhook event has that id."                                                                                                                                                                                                                                                           |
| `error`   | `FormError` above the action, with a retry                                                                                                                                                                                                                                                                      |

`AdminWebhookEventReplayResponse.provider` is worth surfacing, and worth a `Notice` when it
is not `whatsapp`: only the WhatsApp sweeper runs today, so a `billing` event reset to
`received` waits for a worker that does not exist. The API documents this; the UI must not
hide it. Tone `warning`: "Only WhatsApp events are swept today. This one is reset and will
wait."

## 2.10 Impersonate — deliberately not built

`Reqta Admin.dc.html` shows it. **No API exists**, and TAR-800 and TAR-804 both scope it out
pending a security review. Nothing in `apps/admin` renders an impersonate control, disabled
or otherwise — a disabled control is still a promise, and this one is a promise about
crossing a tenant boundary.

---

# Part 3 — TAR-805: public self-signup

The API is complete and the UI is missing. Everything below is drawn from the actual
contracts (`packages/contracts/src/signup.ts`), the error translation
(`apps/api/src/signup/signup.http.ts`) and `SIGNUP_POLICY`. The reference has nothing for
this flow at all, so all of it is new.

## 3.1 Two routes, and where they live

| Route     | What                                                      |
| --------- | --------------------------------------------------------- |
| `/signup` | The form. `POST /v1/signup`, with live slug checking      |
| `/verify` | The emailed link's landing page. `POST /v1/signup/verify` |

`/verify` is **fixed by the API** — `tenant-signup.service.ts` mails
`https://{platform host}/verify#token={token}`. The path is not the frontend's to choose,
and the token is in the **fragment**, so `useLinkToken()` is the reader, unchanged from
invite and reset. Do not write a second one.

Both go in `apps/web/app/(auth)/`, inheriting the signed-out split, the lockup band, the
footer and `robots: noindex`.

**One caveat that is a real decision, not a detail.** `(auth)/layout.tsx` calls
`readBranding()`, which resolves a tenant **from the host**. Signup happens on the
**platform host**, where there is no tenant. Both routes must render the platform's own
default branding — the same fallback `apps/admin` uses (2.2). Verify this renders before
building anything else on the page: a signup screen showing an unrelated tenant's logo is
worse than one showing none.

**`SIGNUP_ENABLED=false` answers `404`, not `403`**, and that is deliberate (a reseller who
turned self-serve off does not want it announced). The route must therefore render Next's
own not-found, not a "signup is disabled" screen — a page that says the feature exists
defeats the API's choice.

## 3.2 The form

`AuthForm`, one field per line, `Field` throughout, in this order:

| #   | Field             | Control                  | Notes                                                                                                   |
| --- | ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | Work email        | `TextInput type="email"` | `autocomplete="email"`. Becomes the first admin                                                         |
| 2   | Your name         | `TextInput`              | `autocomplete="name"`. Help: "Shown to your teammates." Max 120                                         |
| 3   | Workspace name    | `TextInput`              | `TenantNameSchema`                                                                                      |
| 4   | Workspace address | `TextInput` + suffix     | See 3.3. Help: "This is where your team signs in. It cannot be changed later."                          |
| 5   | Password          | `PasswordField`          | Reveal control + `PasswordRequirements` live checklist — both already exist and are 0001's ruled answer |

**The password is taken here, not on the verify page**, and the copy must not imply
otherwise ("You will get an email to confirm this address", never "…to set your password").
The API's own comment gives the reason: a verify page that asks for a password is a page an
interceptor can _complete_.

**Not asked for**: timezone and locale. Both are optional on `SignupInputSchema` and both
default sensibly. Five fields is already the longest form in the product; two more that the
workspace settings screen can change later is friction for nothing.

`AuthForm` supplies the required legend, the pending state, the double-submit guard,
disabled-while-submitting fields, and focus moving to the first rejected field. Do not
re-implement any of it.

## 3.3 The slug field

The one custom control this flow needs, and the reason it exists is in the contract:
provisioning is deferred to `verify`, so the form must say "taken" **before** the reader goes
to check their inbox.

**Structure.** A `TextInput` with a static, non-editable suffix showing the platform domain
(`.example.com`), inside the input's box and in `--color-on-surface-muted` — not a second
field, and not a placeholder. A trailing status slot holds the availability indicator.

**Checking is debounced at 400ms** after the last keystroke, and only once the value passes
`TenantSlugSchema` client-side. `SIGNUP_POLICY.slugChecksPerIpPerMinute` is 30, and the
contract calls that "a debounce backstop rather than a security control" — so the debounce
is the real limit and it must actually hold.

| State          | Indicator                      | Field treatment                                                                                                                                                                                  |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `idle`         | Nothing                        | Default                                                                                                                                                                                          |
| `invalid`      | Nothing — no request is made   | `Field` error from `TenantSlugSchema`, naming the rule it broke                                                                                                                                  |
| `checking`     | `Spinner` in the trailing slot | Default. 0001 permits `Spinner` inside a control the reader is acting on, and this is that                                                                                                       |
| `available`    | Check glyph, `--color-success` | Default. Text beside it: "_acme_ is available." **The glyph is never the only carrier**                                                                                                          |
| `taken`        | Cross glyph, `--color-danger`  | `aria-invalid`, error tint (1.1). Error text: "_acme_ is taken. Try another." — the API's own wording                                                                                            |
| `rate-limited` | Nothing                        | A `Field` **hint**, not an error: "Still checking availability — we will confirm when you submit." A throttle the reader caused by typing is not their mistake, and it must not block the submit |
| `check failed` | Nothing                        | Same as rate-limited. Availability is a convenience; `POST /signup` is the authority                                                                                                             |

**The indicator is `aria-live="polite"`** on the trailing slot, so a screen-reader user
hears the outcome without moving focus. It announces the settled state only — never
"checking".

**Availability never disables the submit.** The check is advisory: the slug can be taken
between the check and the submit, so the form must handle `409` on submit regardless (3.4).
A disabled submit here would be a control the reader cannot fix when the check itself is
what failed.

## 3.4 Every state of `POST /v1/signup`

| Outcome             | HTTP                                       | Screen                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Loading**         | in flight                                  | `AuthForm` pending: fields disabled, submit reads `Creating your workspace…`                                                                                                                                                                                       |
| **Accepted**        | `202`                                      | The form is replaced by `AuthOutcomeCard` — see 3.5                                                                                                                                                                                                                |
| **Slug taken**      | `409 conflict`, detail on `slug`           | Stay on the form. `Field` error on the slug from the API's own detail entry ("That address is already taken."), the indicator flips to `taken`, **focus moves to the slug field**. `AuthForm` already does the focus move — it is why this is not a `FormError`    |
| **Invalid email**   | `400 validation_failed`, detail on `email` | `Field` error on the email. Client-side validation should catch it first; this is the server disagreeing, and the server wins                                                                                                                                      |
| **Rate limited**    | `429 rate_limited`                         | `FormError` above the action: "Too many signup attempts from here. Wait a few minutes and try again." **Do not say which limit** — the API returns one code for the IP limit and the email limit precisely so the answer cannot be read as "that address is known" |
| **Signup disabled** | `404 not_found`                            | Cannot be reached — the route 404s first (3.1). If it arrives anyway, the generic error below                                                                                                                                                                      |
| **Anything else**   | `5xx`                                      | `FormError` with the request id, matching the other signed-out screens                                                                                                                                                                                             |

**The `409`-versus-`400` split is a real product distinction and the UI must keep it.**
`signup.http.ts` chooses `conflict` over `validation_failed` for a taken slug so a client can
tell "fix your input" from "somebody got there first" — only the second is worth
re-prompting for a different name, and the copy differs accordingly.

## 3.5 After submitting — the check-your-email card

`AuthOutcomeCard`, replacing the form. It already takes focus on mount and is already the
shape of the four outcomes on the password screens, so it will not resize the panel.

- Icon `mail`, title "Check your email"
- Body: "We sent a link to **{email}**. Open it to finish setting up **{workspaceName}**."
- Detail: "The link expires {relative time from `expiresAt`}." — `expiresAt` is returned by
  the `202` and is the only place the reader learns the deadline
- Action: `Button variant="secondary"` reading `Resend the link`
- Secondary: a `TextLink` back to `/signup`, labelled "Use a different address"

**Resend** calls `POST /v1/signup/resend` with the email:

| State          | Treatment                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`      | Enabled                                                                                                                                                                                                                                                                                                                                           |
| `loading`      | Pending, `Sending…`                                                                                                                                                                                                                                                                                                                               |
| `sent` (`202`) | `Notice tone="success"` in the card: "Sent. Check your inbox again." The button then enters a **60-second cooldown** — a client-side courtesy, disabled with a live countdown in its label, because the API will happily accept a click-storm and answer `202` to all of it                                                                       |
| `rate limited` | `Notice tone="warning"`: "We have sent as many links as we can to this address. Check your spam folder, or start again with a different address." `SIGNUP_POLICY.resendsPerSignup` is 3 and it is counted on the row, so this is reachable by an ordinary person with a filtering mailbox — it is not an abuse message and must not read like one |
| `error`        | `Notice tone="danger"` with a retry                                                                                                                                                                                                                                                                                                               |

**Resend always answers `202`, whether or not there was a signup to resend.** The success
copy must therefore never assert that a signup exists — "Sent. Check your inbox again." is
deliberately weaker than "We sent another link to your account."

## 3.6 `/verify`

Reads the token via `useLinkToken()`, then `POST /v1/signup/verify`.

| State                              | Source                                              | Screen                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reading`                          | `useLinkToken()` before mount                       | The panel-shaped skeleton the reset screen already uses (`ResetPasswordForm.Skeleton`). Never a bare spinner, and never a flash of the error state                                                                 |
| `missing`                          | No token in the fragment                            | `AuthOutcomeCard`: "That link is incomplete" / "Email programs sometimes cut long links in half. Open it again from your inbox, or request a new one." Action: back to `/signup`, because a resend needs the email |
| `verifying`                        | Request in flight                                   | Card with a `Spinner` and "Setting up your workspace…". This call **provisions a tenant** — it is the slowest request in the product and its budget is 20s. A screen that looks idle for that long reads as broken |
| `success`                          | `201`                                               | See 3.7                                                                                                                                                                                                            |
| `expired` / `consumed` / `unknown` | `410 token_invalid`, reason in `details[0].message` | One card, **three bodies** — below. All offer the way back                                                                                                                                                         |
| `rate limited`                     | `429`                                               | Card: "Too many attempts. Wait a few minutes and open the link again."                                                                                                                                             |
| `error`                            | `5xx`                                               | `ErrorState` with a retry — the token is still good, so retrying is genuinely the right move                                                                                                                       |

**The three `410` reasons get three bodies**, because the reader's next action differs and
the API took the trouble to distinguish them:

| `reason`   | Title                     | Body                                                                                             | Action                      |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------- |
| `expired`  | "That link has expired"   | "Verification links are short-lived. Start again and we will send a new one."                    | `Start again` → `/signup`   |
| `consumed` | "That link has been used" | "Your workspace is already set up. Sign in to open it."                                          | `Sign in` → the tenant host |
| `unknown`  | "That link is not valid"  | "Check you opened the most recent email — an older link stops working once a newer one is sent." | `Start again` → `/signup`   |

`consumed` is the one that matters most and the one a single shared message would ruin: the
reader has a working workspace and is one click from it, and telling them their link is dead
sends them back to a signup form that will refuse their slug.

## 3.7 Success, and the hand-off into onboarding

`201` sets a session cookie **on the platform host** and returns `primaryHostname` — the
tenant's own subdomain, which is a different origin. TAR-805's acceptance criterion is "no
dead-end after verification", and this is where a dead-end would be.

**The screen**: `AuthOutcomeCard`, icon `check`, tone success, "**{tenantName}** is ready",
body "Your workspace is set up and you are signed in as **{email}**.", action
`ButtonLink variant="primary"` reading `Open {tenantName}` → `https://{primaryHostname}/`.

**Redirect automatically after a beat**, and show the button anyway. Around 1.5 seconds —
long enough to read the workspace name and confirm it is the one they meant. The button is
what makes the card work when the redirect is blocked, and what a reader who wants to move
faster presses.

**Do not deep-link into `/onboarding`.** `apps/web`'s own root routing sends a signed-in
principal with incomplete onboarding to the checklist; a signup flow that hardcodes the
onboarding path is a second copy of that decision, and it will be the copy nobody updates.

**Flag, not a design decision** — raised on TAR-805 for the Architect: the session cookie is
set on the platform host, and the tenant lives on another origin. Whether the cookie is
domain-scoped to cover both, or the redirect carries a hand-off, is a session-architecture
question this spec cannot answer from the contracts alone. The `SignupCompletedResponse`
comment mentions the console "signing in again from the invite it already holds", which does
not obviously match what `verify` returns. **Confirm this before building 3.7** — if the
redirect lands on a login screen, the acceptance criterion fails on the last step of the
flow.

---

# Part 4 — Reconciliation, and the check-in

Two obligations remain on TAR-807, and neither is discharged by publishing this file.

## 4.1 Reconcile against TAR-801's landed names

TAR-801 is porting the reference's tokens right now. When it lands, walk this document
against `primitives.css`, `semantic.css` and the new base components, and fix:

- **The four tokens in 0.3.** If TAR-801 landed equivalents under other names, this
  document's names change — the components do not.
- **Any role this spec names that TAR-801 renamed or dropped.**
- **The base component set.** Where TAR-801's button/input/card/badge/nav shell differs from
  what `components/ui/` has today, Part 1's deltas are re-measured against the new baseline
  before TAR-803 starts.
- **Anything in the reference that contradicts a structural decision here.** This spec was
  written without access to the two `.dc.html` files (see the opening section); TAR-801's
  author has read them. Where they disagree with a _structure_ claim here — not a value —
  that is a real finding, and it changes this document.

Post the outcome as a comment on TAR-807, then on each of TAR-803/804/805.

## 4.2 The step-9 check-in

TAR-803, TAR-804 and TAR-805 each carry an acceptance criterion requiring the UI/UX Designer
to check the implemented result against this spec and flag drift **before** the issue moves
to `in_review`. That check needs a running preview or screenshots of, at minimum:

- **TAR-803**: one screen showing each of the seven states in 0.1 on a real control; the new
  `Tooltip` on the collapsed rail; a menu opening and closing; a modal opening and closing.
- **TAR-804**: the credential screen, the Tenants page in its empty and populated states, a
  tenant detail, the delete dialog in `force` mode, and the webhook form's `409`.
- **TAR-805**: the form with the slug field in all six states of 3.3, the check-your-email
  card, and all three `410` bodies.

A spec handed off is not a spec verified.
