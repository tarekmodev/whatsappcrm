# Visual design language (TAR-202)

- **Status**: Accepted
- **Date**: 2026-08-12
- **Issue**: TAR-202 (Design system foundation), under TAR-18
- **Author**: Senior Frontend Engineer
- **Builds on**: [ADR 0001 — stack decision](../adr/0001-stack-decision.md),
  [Architecture and API contract](../architecture/0002-architecture-and-api-contract.md)
- **Supersedes**: nothing. This is the first design decision on the project.

This document is for the engineer building a screen. It fixes what the design tokens
equal and what the recurring layouts are, so a screen built after it looks like the
screens built before it without its author choosing a single colour or margin.

Read it the way you read 0002's API contract: it is the thing your work is measured
against, not a suggestion. `apps/web/styles/tokens/primitives.css` and
`apps/web/styles/tokens/semantic.css` are the executable half of it; when a value here
and a value there disagree, the token file is right and this document is stale — fix it
in the same pull request.

## Context and problem

Before this, `apps/web` had a token layer with no ruled values behind it. The rule
"components never contain a raw colour" was enforced, so nothing was hardcoded, but
nothing said what `--color-accent` should _be_, what the console's frame looked like, or
what a list view was made of. Each story picked a layout, and four screens shipped with
four answers.

Confirmed with the product owner on 2026-08-11: take the visual language from HubSpot —
its frame, its restraint, its density — without taking anything of HubSpot's own. Their
logo, wordmark and brand colours are their trademark. A layout convention is not.

## Goals / non-goals

**Goals**

- One set of ruled token values, so "matches the design" is something you inherit rather
  than something you re-decide.
- One frame — rail, bar, canvas — that every signed-in screen sits in.
- Named structural patterns for the two view shapes this product is mostly made of: the
  list and the detail.
- A default theme that TAR-29's per-tenant white-labelling can sit on top of by
  replacing token values and nothing else.

**Non-goals**

- Per-tenant theme overrides. TAR-29 owns the override mechanism; this owns the default
  it overrides.
- A per-screen redesign of everything already shipped. Screens inherit the new tokens
  through the shared components; deeper polish is separate work.
- A ticket pipeline or Kanban board. Ticket status is a list column, not a board, for
  this pass.
- A component catalogue. The components are documented where they live, in a usage
  comment at the top of each file.

---

## The token layers

Three layers, one direction, and no component may skip a step:

| Layer     | File                                    | Holds                                             |
| --------- | --------------------------------------- | ------------------------------------------------- |
| Primitive | `apps/web/styles/tokens/primitives.css` | Raw scales. Named for what they are (`slate-700`) |
| Semantic  | `apps/web/styles/tokens/semantic.css`   | Roles. Named for what they do (`--color-surface`) |
| Component | `Component.module.css`                  | Reads semantic roles only                         |

A component that reads a primitive has skipped the layer that makes the theme swappable,
because the dark theme and every future tenant theme re-declare **roles**, not scales.

## Colour

Neutral grey and white carry the product. One accent carries action. Nothing else is
allowed to be loud.

### The accent

A deep green, WhatsApp-adjacent rather than WhatsApp's own, and deliberately not
HubSpot's orange. It is the only saturated colour on a screen that is not reporting
status, and it means exactly one thing: **this is the action, or this is where you are.**

| Role                       | Light       | Dark        | Used for                            |
| -------------------------- | ----------- | ----------- | ----------------------------------- |
| `--color-accent`           | `green-600` | `green-500` | Primary buttons, current tab, links |
| `--color-accent-hover`     | `green-700` | `green-300` | Their hover state                   |
| `--color-accent-subtle`    | `green-100` | `green-900` | Selected rows, avatar backgrounds   |
| `--color-on-accent`        | `white`     | `slate-950` | Text on the accent                  |
| `--color-on-accent-subtle` | `green-700` | `green-100` | Text on the subtle accent           |

Every pair clears WCAG AA in both themes. The measured ratios, which is what the values
were picked for rather than the other way round:

| Pair                                              | Ratio  | Floor |
| ------------------------------------------------- | ------ | ----- |
| `white` on `green-600` (primary button, light)    | 5.37:1 | 4.5   |
| `green-600` on the canvas (link on light)         | 5.13:1 | 4.5   |
| `slate-950` on `green-500` (primary button, dark) | 5.73:1 | 4.5   |
| `green-500` on `slate-900` (link on dark)         | 5.07:1 | 4.5   |
| `green-700` on `green-100` (subtle accent, light) | 6.35:1 | 4.5   |
| `green-100` on `green-900` (subtle accent, dark)  | 10.3:1 | 4.5   |
| `slate-300` on `navy-900` (rail label)            | 10.1:1 | 4.5   |
| `slate-400` on `navy-900` (rail muted text)       | 5.86:1 | 4.5   |

A focus indicator is measured against the colour beside it, and its floor is 3:1
(WCAG 2.2 SC 1.4.11) rather than 4.5:1. The rail is the one region where the global ring
is not the answer — see below — so its ring is measured against all three of the
backgrounds it can land on:

| Pair                                                    | Ratio  | Floor |
| ------------------------------------------------------- | ------ | ----- |
| `green-300` on `navy-900` (rail ring, light)            | 8.18:1 | 3     |
| `green-300` on `navy-800` (on a hovered entry, light)   | 6.97:1 | 3     |
| `green-300` on `navy-700` (on the current entry, light) | 5.03:1 | 3     |
| `green-300` on `slate-950` (rail ring, dark)            | 11.0:1 | 3     |
| `green-300` on `slate-700` (on the current entry, dark) | 5.64:1 | 3     |

Re-measure before changing any of them. `--color-on-surface-subtle` is around 2.6:1 and
is decoration only — never put text on it.

### Status colour

Status never gets a saturated fill. Each `--color-*-subtle` is a **tint** — a surface the
eye skims past, with its `--color-on-*-subtle` carrying the meaning in text — because the
accent is the only thing on a screen allowed to be loud, and a chip beside a button that
shouts louder than it inverts the whole hierarchy. `neutral` is a status like the rest and
has its own pair: before TAR-514 it borrowed `surface-sunken` + `on-surface-muted`, which
is how it came to be the one chip nobody had measured, at 4.34:1.

| Role                     | Light       | Dark        | Text role                   | Light       | Dark        |
| ------------------------ | ----------- | ----------- | --------------------------- | ----------- | ----------- |
| `--color-neutral-subtle` | `slate-100` | `slate-750` | `--color-on-neutral-subtle` | `slate-600` | `slate-100` |
| `--color-success-subtle` | `green-100` | `green-900` | `--color-on-success-subtle` | `green-700` | `green-100` |
| `--color-warning-subtle` | `amber-100` | `amber-900` | `--color-on-warning-subtle` | `amber-600` | `amber-100` |
| `--color-danger-subtle`  | `red-100`   | `red-900`   | `--color-on-danger-subtle`  | `red-600`   | `red-100`   |
| `--color-info-subtle`    | `blue-100`  | `blue-900`  | `--color-on-info-subtle`    | `blue-500`  | `blue-100`  |

Two ratios matter for a chip, not one. The **text pair** is the AA floor; the **stand-off**
is how far the tint sits from the surface behind it, and it is the number that decides
whether a chip out-shouts the button beside it. `apps/web/styles/tokens/tokens.test.ts`
asserts both against the token files, so neither can drift the way the dark theme did.

| Chip      | Text, light | Text, dark | Stand-off, light | Stand-off, dark |
| --------- | ----------- | ---------- | ---------------- | --------------- |
| `neutral` | 6.92:1      | 11.4:1     | 1.10:1           | 1.43:1          |
| `accent`  | 6.35:1      | 10.3:1     | 1.19:1           | 1.46:1          |
| `success` | 6.35:1      | 10.3:1     | 1.19:1           | 1.46:1          |
| `warning` | 6.07:1      | 10.9:1     | 1.13:1           | 1.46:1          |
| `danger`  | 7.33:1      | 10.1:1     | 1.22:1           | 1.45:1          |
| `info`    | 5.46:1      | 10.1:1     | 1.23:1           | 1.45:1          |

Text floor 4.5:1. The accent's own stand-off is **5.37:1 light and 5.07:1 dark**, so the
ordering on any screen is: solid accent button > chip > body text > muted text.

#### Two roles that are identity, not status (TAR-518)

Both alias a status role rather than a primitive, so a tenant re-theming `warning` moves
the note surface with it and a tenant re-theming `danger` moves the failure. They are
named separately because a component reading them is asking a different question: not
"how urgent is this" but "what kind of thing am I looking at".

| Role                      | Aliases                     | Where                                               |
| ------------------------- | --------------------------- | --------------------------------------------------- |
| `--color-note`            | `--color-warning-subtle`    | The composer while its destination is `Comment`     |
| `--color-on-note`         | `--color-on-warning-subtle` | The text on it                                      |
| `--color-note-marker`     | `--color-warning`           | The leading bar on that surface and on a note card  |
| `--color-delivery-failed` | `--color-danger`            | An outbound message that did not reach the customer |

A note reaching a customer is the worst bug this product could have, so "internal" is
carried three ways at once: the surface, the marker, and the words on the panel. Colour
alone is never the carrier, and the marker is what survives forced-colours mode.

`--color-delivery-failed` is measured on the **bubble surfaces** rather than on `surface`,
because that is where it lands — `--color-accent-subtle` for an outbound bubble. It clears
AA on all three in both themes (`tokens.test.ts` asserts it). The other four delivery
states have no colour of their own: they are metadata, they take the bubble's own muted
role, and they differ by glyph and by the word beside it.

#### Why the stand-off, and not the hue

TAR-29 lets a tenant replace the accent, and the seeded workspace resolves it to a blue —
the same hue as the `info` chip. A dark theme that separated chips from the accent _by
hue_ was therefore one tenant away from re-breaking, which is exactly what happened: a
`2 unread` chip and a `Claim` button rendered as near-identical blues at the same weight.

So the separation is **lightness and chroma**. Every chip tint sits at the same small
stand-off from the surface whatever its hue; a solid accent button sits two to five times
further out whatever hue a tenant supplies. `tokens.test.ts` sweeps the hue wheel through
`brandCssVariables` rather than checking the default green.

The one boundary: a tenant whose primary colour is itself within ~1.5:1 of the console
surface — a near-black brand in the dark theme — makes its own button quiet. The branding
screen already reports a colour's measured contrast; nothing in the token layer can save a
brand from being invisible against the surface it was chosen to sit on.

### Surfaces

| Role                           | Light       | Dark        |
| ------------------------------ | ----------- | ----------- |
| `--color-canvas`               | `slate-50`  | `slate-950` |
| `--color-surface`              | `white`     | `slate-900` |
| `--color-surface-sunken`       | `slate-100` | `slate-950` |
| `--color-surface-hover`        | `slate-100` | `slate-800` |
| `--color-surface-sunken-hover` | `slate-200` | `slate-800` |
| `--color-border`               | `slate-200` | `slate-700` |

Light grey canvas, white cards, hairline borders. A card is separated from the canvas by
its **border** first and its shadow second — a shadow doing the whole job reads as a
floating panel rather than a section of a page.

**There are two hover surfaces, and picking the wrong one is silent.**
`--color-surface-hover` is for something sitting on `--color-surface`;
`--color-surface-sunken-hover` is for something sitting on `--color-surface-sunken` — a
conversation row, which has no surface of its own and takes its column's. In the light
theme `--color-surface-hover` _is_ `--color-surface-sunken`, so a row that used it was
hovered to exactly the colour it already was, and a row with no action gave no feedback at
all (TAR-517). Match the hover role to the surface underneath, not to the component.

### The rail

The navigation rail is a dark region in both themes. That is the layout, not a
consequence of the light palette, so it has its own roles (`--color-rail`,
`--color-on-rail`, `--color-rail-selected`, …) mapping onto a `navy` family that is
independent of the neutral text scale. Retuning the rail must not move body text, and
retuning body text must not move the rail.

Dark theme drops the navy for the neutral scale: navy against a near-black canvas reads
as a colour cast rather than as a distinct region.

Two consequences of the rail staying dark while the theme flips around it:

- **It has its own focus ring**, `--color-focus-ring-on-rail`, applied once in
  `AppSidebar.module.css`. The global `--color-focus-ring` flips with the theme, so the
  light-theme ring landed on navy at 2.80:1 and on the current entry at 1.72:1 — below
  SC 1.4.11's 3:1. This is the only override of the app's one focus style, and a control
  added to the rail later inherits it without knowing that.
- **`--color-on-rail-muted` is the ruled answer for secondary text on the rail** — a
  section heading, a count beside a label. Nothing reads it yet. It is declared and
  measured so the first control that needs it inherits an answer instead of choosing a
  grey and hoping.

## Typography

Figtree, a clean geometric sans, self-hosted through `next/font` in
`apps/web/app/layout.tsx`. Self-hosted means no runtime request to a third party, no
consent question, and no layout shift on load.

One family, one variable axis, three weights from the scale — regular, medium, semibold.
Sizes come from `--font-size-*`; the two heading sizes above body are fluid via `clamp()`
so a heading does not need a breakpoint to stop being enormous on a phone.

`--font-size-metric` is the one step above the headings, and it belongs to exactly one
thing: the figure on a metric tile (TAR-519). A tile's job is to be scanned, so the number
has to win against everything around it, and the largest heading size reused there made it
the same weight as the label above it. It is fluid like the headings, and it is never a
heading — a screen that reaches for it to make a title bigger has the wrong token.

Never set a font size in a component. If a size is missing from the scale, add it to the
scale.

## Spacing and shape

- **Spacing**: an 8px rhythm with 4px half-steps. Every step from `--space-2` up is a
  multiple of 8; `--space-1` and `--space-3` are the half-steps a dense control needs.
  Nothing spaces itself off the grid.
- **Radius**: `--radius-sm` 4px for a tight inline mark, `--radius-md` 6px for controls,
  `--radius-lg` 8px for cards, `--radius-pill` for pills and avatars. Cards and controls
  are the 6–8px range; anything rounder belongs to a pill.
- **Elevation**: three soft, low shadows — `--shadow-raised` for a card,
  `--shadow-overlay` for a popover, `--shadow-modal` for a dialog. There is no fourth.
- **Motion**: `--duration-fast` for a colour change, `--duration-medium` for a panel,
  `--easing-standard` for both. Reduced motion collapses the durations in the token
  layer, so no component branches on the preference.

## The console frame

Every signed-in screen is composed of four regions, and `AppShell` owns the geometry of
all of them:

```text
┌───────────┬─────────────────────────────────────────┐
│           │  top bar — identity, theme, sign out    │
│   rail    ├─────────────────────────────────────────┤
│  (fixed)  │                                         │
│  icon +   │  canvas — page header, then sections     │
│  label    │  as white cards                         │
│           │                                         │
└───────────┴─────────────────────────────────────────┘
```

| Region  | Component                                  | Notes                                                                                                            |
| ------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Rail    | `apps/web/components/shell/AppSidebar.tsx` | Fixed, collapsible, icon + label, More/Less past five entries, footer slot                                       |
| Top bar | `apps/web/components/shell/AppTopBar.tsx`  | Search, quick create, account menu; the drawer trigger below the breakpoint. One `--size-bar` row at every width |
| Canvas  | `apps/web/components/shell/PageShell.tsx`  | Gutter and vertical rhythm for the sections, or a full-height workspace                                          |
| Drawer  | `apps/web/components/shell/MobileMenu.tsx` | The rail, below 48rem: the wordmark, the same nav, and the account block at its foot                             |

Rules that hold for all of them:

- **One navigation data source.** `apps/web/components/shell/navigation.ts` is it. The
  rail, the drawer and the settings tabs all render from that array, filtered once on the
  server by permission. There is no second copy of the nav markup for mobile.
- **The rail's destinations are Inbox, Contacts, Tickets, Reports and Settings**, in that
  order. Each is added to `NAV_ITEMS` with its icon by the story that builds the route
  behind it — an entry added ahead of its route is a nav link to a 404. Today the array
  holds Inbox and Settings, because those are the routes that exist.
- **Collapsed is a preference, not state.** It is stored in the `wac_rail` cookie and read
  on the server, so the frame is the right width in the first HTML response. Collapsing
  hides the labels from the eye only; the links keep their accessible names.
- **Below 48rem there is no rail.** It is removed rather than hidden, so its links leave
  the tab order, and `MobileMenu` — focus-trapped, Escape-closable, scroll-locking — is
  the navigation. Being the rail, it carries what the rail carries: the wordmark at its
  head, the navigation scrolling between, and the account block pinned to its foot. The
  panel slides at `--duration-medium`/`--easing-enter` with the scrim fading at
  `--duration-fast`; the token layer flattens both under `prefers-reduced-motion`.
- **The top bar's search searches conversations, and says so.** 0002 exposes `?q=` on
  `GET /conversations` and on nothing else, so `TopBarSearch` submits to `/inbox?q=…` and
  is labelled for what it does. It widens to contacts and tickets when their reads land —
  a box labelled "search everything" that only reaches one resource is worse than a
  narrow one that is honest.
- **The rail shows five destinations, then a More/Less boundary.** `NavLinkList` renders
  the disclosure only when there is something behind it, so a short nav grows no control
  saying so. The rail also has a footer slot (`RailCard`) for a persistent card below the
  navigation; nothing passes one today.
- **Nothing goes in the shell for a feature this product does not have.** No notification
  bell, no app switcher, no assistant, no call button — each is a promise the app breaks
  the moment somebody presses it. They arrive with the stories behind them, and the same
  rule governs the quick-create menu: `quick-create.ts` lists links to surfaces that
  exist, filtered by permission, and an empty list renders no `+` at all.
- **The workspace is not named in the bar.** The session contract carries a `tenantId`
  and no tenant name (`packages/contracts/src/auth.ts`); naming and branding the workspace
  is TAR-29.

#### The bar is one row, at every width (TAR-522)

```text
below 30rem   [ ≡ ]                     [ ⌕ ] [ 🔔3 ] [ + ] [ ◍ ]
30–48rem      [ ≡ ] Northwind Support   [ ⌕ ] [ 🔔3 ] [ + ] [ ◍ ]
48rem and up        [ ⌕ search conversations ]  [ 🔔3 ] [ + ] [ ◍ Omar Farouk / Admin ⌄ ]
```

`AppTopBar` does not wrap. It used to, and below 48rem it wrapped into three rows —
trigger and wordmark, then bell and quick-create, then the search field on a line of its
own — which measured 161.4px of an 844px phone before the page had said anything, put a
visible "Open menu" caption across the wordmark beside it, and dropped the account menu
entirely. The rules that keep it one `--size-bar` row:

- **Icon-only controls are named by `aria-label`, never by a caption.** That is the fix
  for the drawer trigger's label; a visible caption under a hamburger is not an
  accessibility feature, it is a second row.
- **The search is a trigger below 48rem, and the field expands _over_ the bar.** Out of
  flow, so the row behind it keeps its height. Activating it moves focus into the field;
  Escape and the close button collapse it and hand focus back to the trigger. Nothing is
  trapped. A collapsed trigger with a term applied carries a mark and says the term in its
  accessible name — the field is allowed to hide, an applied filter is not.
- **The account menu is in the bar at every width, and is the last thing to give way.**
  It is the only route to sign out and to the theme. Below 48rem the trigger is the avatar
  alone (`PrincipalIdentity isCompact`); the name, the role and the chevron return above
  it. The drawer carries the same block pinned to its foot as well, because a control you
  have to scroll a nav list to reach is one you cannot rely on.
- **The wordmark is the first thing to give way.** It stands down below 30rem, which is
  the measured width at which the full lockup stops fitting beside the five controls
  (150px available against 142px needed at 480px, and 67px at 390px). The drawer heads its
  navigation with the same `BrandLockup`, so the workspace is still named at 320px.
- **Order of sacrifice, if a sixth control is ever added.** Wordmark first, then the bell
  and the quick-create move _into_ the account menu. The row is never allowed to wrap and
  nothing is ever silently dropped. The bar's min-content is about 252px today, against
  294px of content box at 320px; that is the number to re-measure.

#### The canvas has two variants: `flow` and `fill`

`PageShell` takes a `variant`, and it is **opt-in per route**. Ordinary screens — Reports,
Tickets, Settings — say nothing and get `flow`. A list-and-detail screen that should read
as one workspace asks for `fill`. The inbox is the only route on it today.

|           | `flow` (default)                                                             | `fill`                                                        |
| --------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Height    | Grows with its content; the document scrolls                                 | Exactly the region the bar left; the document does not scroll |
| Width     | Capped at `--size-container-xl`, fluid gutter                                | Full-bleed — no cap, no gutter                                |
| Rhythm    | `Stack gap="5"` between sections, block padding, toast clearance at the foot | None: the workspace owns its own interior                     |
| Scrolling | The page                                                                     | Each column inside, with `overscroll-behavior: contain`       |

Three things about `fill` are load-bearing, and each of them is a mistake somebody would
otherwise make again:

- **Fill the space with flex, never with arithmetic.** `calc(100dvh - var(--size-bar))` is
  wrong even now that the bar is one row of exactly that token: it also carries the
  device's safe-area inset, it grows with the text at 200% zoom, and the next thing added
  to it would break an arithmetic that nothing checks — at exactly the width where a
  pinned composer matters most. `AppShell` instead sets `block-size: 100dvh`
  and `overflow: hidden` on the frame, and `min-block-size: 0` on the column and on
  `<main>`, so `<main>` measures whatever the bar actually left. There is no height token
  to keep in sync, and there must not be one.
- **Full-bleed means full-bleed.** `fill` drops `Container`'s `xl` cap along with the
  gutter and the block padding. Keeping the cap would put canvas either side of the
  workspace above 90rem — the same defect as ragged column bottoms, rotated 90°. The
  hairline dividers between columns are the structure; a gutter has nothing left to do.
- **Something has to keep the toast off the pinned control.** `flow`'s block-end padding is
  what does that on an ordinary page, and `fill` deletes it. The toast region reads
  `--offset-toast-block-end` (declared `0` in `semantic.css`), and a route that pins a
  control to the viewport bottom publishes that control's measured height through
  `useToastClearance`. A toast must never cover a send button.

`AppShell` reads the variant from `[data-page-shell='fill']` with `:has()`, because the
shell is an ancestor of the page and a page cannot hand its ancestor a prop. That attribute
is a documented seam, the same kind as `[data-rail]` in the other direction.

## Status vocabulary

Colour was only half of the badge soup. The other half is that every screen rendered every
fact it had as its own pill, so an inbox row carried five of them and none of them meant
more than any other. Four rules, and they are as binding as the token rules:

- A list row shows **at most one** status chip. A detail header shows at most **two**.
- **A status the active filter already implies is not shown.** "Open" under the "All open"
  filter, "Unclaimed" under "Unassigned": the column on the left has just said it. `open`
  is never a chip at all — it is the ordinary state of a conversation in an inbox, and a
  word on every row is a word nobody gains anything from. Its absence says it, the same
  way an unlabelled bot state says "the chatbot never touched this".
- **Assignment is an avatar with an accessible name**, never a text pill. A held thread is
  a _who_, and a who is a face.
- **A count is the `count` variant**, never a sentence in a pill. A zero renders nothing —
  a column of zeroes reads as a broken screen.

Which chip wins the one slot is a decision, not an accident: order the candidates
most-actionable first and take the top one. `apps/web/features/inbox/conversation-chips.ts`
is the worked example, and it is a pure module with its own test rather than a rule living
inside a component.

### A table row is the one place the budget is two (TAR-520)

A ticket row answers two questions a conversation row does not have to — **how urgent** and
**how late** — in two separate columns, and folding them into one slot would hide whichever
lost. So the ticket queue’s budget is two, ranked breach → priority → status → running
timer, in `apps/web/features/tickets/ticket-chips.ts`. Three pills (`Urgent` `Open`
`Overdue`) is three things competing for one glance and none of them winning.

**A mark that loses the budget goes quiet; it does not disappear.** `Badge`’s `quiet`
variant keeps the word and drops the pill, the tint and the tone. This is the difference a
table makes: a conversation row can simply omit the chip it did not pick, but a column
header stays whether or not its cell has anything in it, and below 40rem `DataTable`
repeats that header beside the value — so an omitted mark is a labelled blank, which reads
as missing data. The reader loses the emphasis, never the fact.

**Nothing the filter has already named is loud**, priority or status: under `?priority=high`
a `High` pill on every row is the filter repeated once per ticket.

### The chip itself

`components/ui/Badge.tsx`, in two sizes — `sm` for a row or a cell, `md` for a detail
header. There is no third.

| Variant   | Use                                         | Treatment                                            |
| --------- | ------------------------------------------- | ---------------------------------------------------- |
| `subtle`  | Status in a row, a cell, a header (default) | The tone's `*-subtle` tint, `on-*-subtle` text, pill |
| `outline` | Low-emphasis metadata — a channel, a team   | Transparent, hairline border, muted text; no tone    |
| `count`   | Unread counts, filter counts                | Pill, tabular numerals, one width for `1` and `99`   |
| `dot`     | Presence of unread, with no number to give  | A circle in the tone's colour, no text               |

`dot` is decorative by construction and carries no accessible name — the parent supplies
one. A dot on its own conveys state by colour alone, which this document forbids.

## Data visualisation (TAR-519)

### The series palette is not the brand's

Every other colour role on this screen is a tenant's to replace. A chart's series are not,
and that is the one exception in the token layer.

While one series took `--color-accent`, the seeded workspace — whose brand TAR-29 resolves
to a blue — drew `Opened` at `rgb(15, 111, 222)` and `Resolved` at `rgb(29, 78, 216)`: two
shades of one hue, separated by a little lightness. It worked when the accent happened to
be green, which is not the same as working. A chart whose two series cannot be told apart
is a chart with no series at all, and no amount of tenant goodwill fixes that.

| Role              | Light                        | Dark                         |
| ----------------- | ---------------------------- | ---------------------------- |
| `--color-chart-1` | `chart-blue-500` `#1d4ed8`   | `chart-blue-300` `#5b8ce8`   |
| `--color-chart-2` | `chart-orange-500` `#dd6b12` | `chart-orange-300` `#fdba74` |

Blue against orange, chosen twice over. It is the pair that survives every common
colour-vision deficiency — the red/green and the blue/yellow confusions both leave it
standing — and the two steps are separated in **lightness** as well, so the distinction
also survives a greyscale print.

Two ratios matter, and both are asserted in `apps/web/styles/tokens/tokens.test.ts`:

| Measurement                       | Light  | Dark   | Floor |
| --------------------------------- | ------ | ------ | ----- |
| `--color-chart-1` on `surface`    | 6.70:1 | 5.41:1 | 3:1   |
| `--color-chart-2` on `surface`    | 3.39:1 | 10.6:1 | 3:1   |
| The two series against each other | 1.97:1 | 1.96:1 | 1.8:1 |

3:1 is WCAG 2.2 SC 1.4.11 — a graphic that carries meaning against its background. The
third row is this document's own floor, and it is the one that would have caught the bug.

Series one is the deeper of the two in **both** themes, so a reader who learns the chart in
one does not relearn it in the other.

### Colour is never the only carrier

Three at once, and colour is the first of the three to fail:

- The **token**, from the table above.
- The **shape** — a square swatch for series one, a circle for series two, repeated in the
  bars' own corner radius. It survives a greyscale print, a projector and forced-colours
  mode, none of which keep the hue.
- The **word**, in the legend and in each column's accessible name.

### What a chart owes a reader

- A **labelled value axis**: three to five gridlines at hairline `--color-border`, on
  values a person reads without arithmetic (`chart-scale.ts` picks them). A bar measured
  against nothing is a decoration.
- **Dated columns** at the interval the range is read in — weekly over a month, monthly
  over a quarter — not the two endpoints.
- **A per-day readout** on hover _and_ on focus, with the hovered column's neighbours dimmed
  at `--duration-fast`.
- **Keyboard reach**: one tab stop for the chart, arrow keys between the days, and each
  day's figures as its own accessible name. The readout is `aria-hidden` — a screen reader
  gets the numbers from the thing the user is on, once.
- **Zero is drawn.** A day with nothing in it gets a neutral baseline tick, never a gap: an
  empty stretch reads as missing data, which is the opposite of a quiet week.
- **Entry motion** grows the bars from the baseline at `--duration-medium` /
  `--easing-enter`, staggered by `--duration-stagger` per column and capped at
  `MAX_STAGGERED_COLUMNS`. Reduced motion collapses both in the token layer, so no
  component branches on the preference.

### Figures in a table

A column of numbers a reader compares by eye lines up on its last digit: `DataTable`'s
`isNumeric` gives a column inline-end alignment and tabular numerals, once, so no table
remembers to do it itself. It applies only when the table is a table — in the stacked card
layout a value sits under its own label and has no column to line up with.

**Absence is quiet.** An unmeasured duration renders `—` for the eye with the words behind
it for a screen reader (`MeasuredDuration`). "No data" repeated down two columns read as six
problems where it is six blanks. The one place it keeps the words is a metric tile's hero
figure, where the absence _is_ the answer to the question the tile asks.

**A sortable column is a link**, and the order lives in the URL — so a sorted table survives
a refresh and can be sent to somebody. `aria-sort` reports what is true now; the link's
accessible name says what pressing it will do.

**Relative time has an upper bound.** `RelativeTime` phrases anything inside
`RELATIVE_TIME_MAX_DAYS` (30) as "3 days ago" or "in 7 days", and everything past it as the
absolute date. "in 26,430 days" is arithmetic rather than an answer — a reader converts it
back into a year before it means anything — and the ticket queue’s SLA column is where that
showed up. The rule lives in the component so every surface inherits it, and the server
still renders the absolute value first: computing "now" during render is a hydration
mismatch, not a feature.

## Structural patterns

### List views

Contacts, Tickets, and the agents table today:

1. `PageHeader` — the `<h1>` and the one primary action, **where there is one**.
2. A filter row — `FilterBar`, and the rules below.
3. A queue header — the count and the order, and the rules below.
4. `DataTable` inside a `SectionCard`.
5. Row actions **inline in the last column**, as real buttons or links. Never hover-only:
   a touch device has no hover, and a keyboard user has no way to reveal one.

**A list with nothing to create has no header action, and that is finished rather than
unfinished.** Tickets are never opened by an agent pressing a button ("Ticket status"
below), so the ticket queue’s header is the `<h1>` and its subtitle and nothing else. The
empty trailing slot is not filled with a secondary control to balance it — a page whose
only action is an export gains nothing by promoting the export.

Every filter lives in the URL, never in component state. A refresh, a copied link and the
back button must reproduce the same list. Below 48rem `DataTable` re-flows each row into a
stacked card with its column headers repeated per cell — the same markup, no second table.

#### The queue header (TAR-520)

A list that scrolls owes the reader two facts before the rows start, and both belong **in a
bar at the top of the list** rather than in prose beside its title:

- **The count**, at the inline start. It is the _page’s_, never a tenant total — none of
  these reads carries a `count(*)` — so a page with a cursor behind it says "25+ tickets"
  and a complete one says "6 tickets".
- **The order**, at the inline end. Where the API can serve more than one order it is a
  `MenuButton` whose entries are real links and whose value is in the URL, as the inbox’s
  is. Where it can serve only one — the ticket queue, whose order is `priority DESC,
createdAt DESC, id DESC` and which has no `sort` parameter by decision (ADR 0006 §6) — it
  is a **label in the same slot**, not a menu with a single entry. A control that offers no
  choice is worse than a statement, and re-sorting a cursor page in the browser is a list
  that lies about what is at the top of the queue.

The bar replaced a card description reading "Urgent tickets come first, then the most
recently opened." A sentence under a card title is a paragraph doing a control’s job, and
it sat where the count should have been.

**Where the card’s title only restates the `<h1>`, hide it** — `SectionCard`’s
`isTitleVisible={false}`, which keeps the heading for the document outline and for the
region’s accessible name. "Ticket queue" under "Tickets" is the same word twice, and the
visible top of that card is the queue header. This is for a route with **one** card; a page
of several needs each of them named.

#### The filter row (TAR-516)

Three screens had independently invented one. It is `FilterBar`, and it obeys five rules:

- Filters sit in **one row on one baseline**, inside a `--color-surface` bar with a
  hairline — not floating on the canvas as separate groups. Below 48rem the row becomes a
  column; three controls do not share a line at 320px.
- **A group label above a control is only used when the control's own value does not say
  what it filters.** `Scope` over pills reading "Assigned to me / Unassigned / All
  tickets" is redundant. Where a select would otherwise need one, name its empty option
  for the group instead — "All roles", not "All".
- **More than two filter groups:** the primary scope stays visible as `FilterPills`, the
  rest collapse into one `FilterMenu` — a "Filters" trigger with a count badge — and an
  `ActiveFilterChips` strip sits beneath the bar naming each one that is on, each chip
  individually clearable. The ticket queue is the case this exists for: four groups and
  seventeen pills across four labelled rows pushed the queue itself below the fold.
- **Search fields** are `SearchField`: capped at `--size-container-sm`, a leading search
  icon, a label that is present even when it is only for screen readers, and a clear (×)
  affordance once there is something to clear.
- **No browser-default control chrome.** A native `<select>` keeps its element and its
  keyboard model but loses the platform's painting of it — `Select` gives it
  `TextInput`'s box and this app's chevron, and `variant="filter"` caps it at
  `--size-menu`. Dates are `DateRangeField`, never `<input type="date">`: the browser's
  own calendar glyph and its own `18/07/2026` disagree with every other date on screen.

### The signed-out screens (TAR-521)

Sign-in, invite-accept and password-reset share one frame, and it is the only screen in
the product some people ever see. It is a **split**: a form panel on the leading side and
a brand panel filling the rest.

- **Form panel** — `--color-surface`, full height, exactly as wide as the form column
  plus its gutters. It holds three landmarks and nothing else: the lockup band, `<main>`
  with the screen's single `<h1>`, and a footer carrying the support link and the theme
  control. The form is centred in what is left over, with the void above it capped at
  `--size-band` so a tall screen does not leave it floating.
- **Brand panel** — `--color-rail`, the navy that frames the console when somebody is
  signed in, carrying the product name at display size, one line of positioning, and a
  motif of a disc, a ring and a rounded square. The ring is the only thing drawn in
  `--color-brand-decor`; the motif is in flow below the copy, never behind it, because
  that colour is the tenant's and no contrast guarantee can be made about it. The panel
  is `aria-hidden`: the lockup beside the form is the accessible spelling of the name,
  and announcing the workspace twice before the heading is worse than announcing it once.
- **Below 64rem** the brand panel is gone and the lockup band takes the rail colour — the
  same brand at a width with no room for a second panel.

There is **no card**. The panel is the surface, and a white box drawn on a white panel is
the outline of a frame this screen used to be missing.

Every password input carries a reveal control at its trailing edge whose accessible name
says what pressing it will do next, and every password being _set_ carries the policy as
a live checklist rather than as a sentence to remember. The required `*` has a legend.
While a form submits, its fields are disabled and the block submit button says which flow
is in flight.

### Detail views

A contact, a ticket, a conversation:

1. A left summary panel with the key fields, which stays put.
2. A main area whose content is chosen by a `Tabs` strip — activity, then whatever else
   the entity has.

The tab is a real link and the active tab is in the URL, for the same reason the filters
are. Below the breakpoint the summary panel stacks above the tabbed area rather than
sitting beside it.

### The inbox

Four regions inside the console frame, owned by `InboxLayout`, and the one route on the
canvas's `fill` variant: the filter column, the conversation list, the open thread, and the
context panel beside it. Below 64rem one region is on screen at a time and the filters
collapse into their own disclosure; from 64rem the list and the thread sit side by side
with the filters a band above and the context panel a band under; from 84rem the filters
take a column of their own; from 105rem the context panel takes one too.

It is a **workspace, not a page of cards**, and that is a geometry rule rather than a
decoration:

- The four regions fill the height exactly and each scrolls itself. The composer is
  pinned to the foot of the thread column and is reachable without scrolling at every
  width. Below 48rem the height it is competing for is the whole screen minus one
  `--size-bar` row (TAR-522); the return to the list is a leading chevron and a label
  inside the thread's own header, not a line of its own above it.
- They are separated by hairline dividers, not by gaps and radii — no canvas shows
  between, beneath or either side of them. The filter column's divider is a
  `border-block-end` while it is a band and a `border-inline-end` from 84rem, because it
  is a row before it is a column.
- The regions that index the work (filters, list) sit on `--color-surface-sunken`; the
  ones that hold the reading (thread, context) sit on `--color-surface`. That is what
  gives the thread its emphasis; no shadow does it.
- There is **no `PageHeader` on this route** and no card titles. The workspace is the
  page: the `<h1>` is visually hidden for the document outline, and the filter column's
  own "Inbox" heading is the visible one. Each region carries its accessible name on
  itself (`aria-label`), which is what the card headings used to supply.

The filter entries are data (`features/inbox/inbox-filters.ts`), each a scope plus an
optional status — so there is no entry the conversations endpoint cannot answer. The
composer's destination (customer, or internal note) is a labelled tab strip, never a mode.

#### The conversation list is a queue, not a stack of cards (TAR-517)

The list column is the one place in this product where **density is the feature**. An
agent triaging it is scanning, not reading, and a column that shows three conversations is
a column they have to scroll to understand. The rules:

- A row is **`--size-row-list`** (64px): a leading `Avatar`, a body of exactly two lines —
  contact name, then one line of preview, both truncated with an ellipsis — and a trailing
  zone holding the timestamp over the row's marks. A row whose height depends on how much
  the customer typed is not a row.
- Rows are separated by a **hairline inset to the body's edge**, so it starts after the
  avatar gutter. No per-row border, radius, shadow or gap — the same rule the four regions
  follow, for the same reason. `ConversationList.module.css` owns that inset and the
  row's inline padding, because the divider and the row's leading column have to be one
  number.
- **No action rests in the row.** `Claim` / `Take over` appear in the trailing zone on
  hover and on `:focus-within`, as `secondary` — never solid accent, which repeated down a
  column outnumbers the screen's one real primary action. Where there is no hover to
  reveal them (`@media not all and (hover: hover)`) they are simply always there, at full
  touch-target height, and the row is taller to fit: this document's "never hover-only"
  rule is answered by the focus and pointer rules, not by an overflow menu.
- **The selected row lifts to `--color-surface`** — the reading surface, matching the
  thread column beside it — plus a `--size-marker` accent bar on its leading edge. Not
  `--color-surface-selected`: that role is a green tint in the light theme and a slate one
  step off the surface in the dark one, so the same rule read as two different states. A
  surface change plus a marker reads identically in both and survives forced colours.
- **The column has a header**: the result count on the left, the order on the right, both
  sticky. The count is the page's own, never a tenant total — the list read carries no
  `count(*)` — so a page with a cursor behind it says "25+".
- The order is `CONVERSATION_SORTS`, and it is **in the URL** (`?sort=oldest`), carried by
  every row link and every filter entry. The default is left out of the URL rather than
  written on every link. This is the one list whose order the console picks; the ticket
  queue's order is still the API's alone (ADR 0006 §6), because that queue has one right
  answer and this one has two.
- A row the socket pushes in **expands from nothing to its height** at `--duration-medium`
  / `--easing-enter`, so the queue visibly changes rather than shunting under the cursor.
  The first render is a page load, not twenty-five arrivals — `features/inbox/entering-rows.ts`.
- A row's accessible name is the contact plus everything the row says in shape and colour
  alone: `"Open the conversation with Fatima Al-Zahra, 2 unread, Bot handed over"`. The
  unread circle and the selection bar are never the only carriers.

Not built yet, and deliberately: the leading slot's **selection checkbox** and the
header's select-all with bulk actions. 0002's conversation endpoints all address a single
id — there is no bulk claim, assign or status route — so a checkbox would select rows for
actions that cannot be performed. It lands with the endpoints.

#### The thread column is a conversation, not a message table (TAR-518)

Three parts in a fixed-height column: a header that stays put, a stream that scrolls, and
the composer pinned to the foot.

**The header** is two rows. Identity first — a 32px `Avatar`, the contact's name at
`--font-size-heading-sm`, the number under it — with the action cluster opposite. Then at
most **two** status chips, who holds the thread _in words_ beside their mark, and when it
started. It carries **no notice of its own**.

**Exactly one solid accent button** on the screen, and which one is a decision, not an
accident: `features/inbox/thread-state.ts` names it, and every other control is
`secondary`. On an unclaimed thread the chatbot is answering, that button is `Claim` —
stopping the bot writes nothing about who holds the conversation, so an agent who pressed
`Take over from the bot` first still could not reply. Both controls are on screen; only one
is inviting.

**Why the header says nothing.** It used to carry a full-width saturated notice about the
chatbot while the composer carried a second one about the claim — two loud blocks in one
column, overlapping in meaning, above and below the messages they were about. There is now
**one line, quiet, at the composer**, because that is where the reply the reader cannot
send was going to be typed. `Notice variant="quiet"` is the treatment: the tone survives in
a leading marker, the fill goes, and the text inherits so it is legible on whatever surface
it lands on.

**The stream** groups consecutive messages from one sender, within five minutes, into a
**run**: one avatar, one label line — sender, time, channel — and the bubbles under it at
`--space-1` against `--space-3` between runs. Four lines from one customer are one person
saying one thing; a name and a timestamp over each of them is a message table with rounded
corners. `features/inbox/message-runs.ts` decides where a run starts.

- **Direction is in the text**, not only in the side and the tint: the label line opens
  with a visually hidden "From the customer" / "From your team", once per run.
- **The stream is bottom-anchored.** A two-message conversation sits on the composer, not
  at the top of a column with five hundred pixels of nothing under it.
- **Delivery state** rides at an outbound bubble's trailing edge as a glyph plus its own
  word. A failure is on the message with a retry beside it — never only in a toast, which
  is gone in seconds while the bubble stays looking sent for as long as the thread exists.
- **A reader who has scrolled up is not yanked.** New messages raise an "N new messages"
  pill over the foot of the stream instead.
- The stream is a `log` landmark whose own live behaviour is **off**, with a separate
  polite region carrying one sentence — "sender: text" — per arrival. A live `<ol>`
  announces whatever React moved, which on a thread grouped into runs is the last run
  entire.

**The composer** is the writing surface and one toolbar under it: attachments and the
template picker at the leading edge, the service-window countdown, an expand control and
Send at the trailing one. It was five stacked blocks and about 630px tall — a two-line
banner over a labelled textarea over a labelled file input over a status line over a Send
row — which on a 1440x900 screen left the message stream a quarter of its column. The
banner is a caption, the labels that repeated the composer's own tab are gone, and the file
input is trimmed to its button.

The destination stays a labelled tab strip, never a mode — and selecting `Comment` moves
**the whole surface** to `--color-note`, because the tab is a small mark at the top of a
box an agent is looking at the bottom of.

Internal notes stay **out of the message stream**, deliberately. They are a separate entity
behind separate endpoints specifically so no send path can pick one up by accident, and
interleaving them into the stream would put note content inside the structure a send walks.

### Ticket status

A column in the list, rendered as a `Badge`. Not a pipeline, not a board, not a drag
target. A board is a different story and a different data shape; do not build half of one
into a list view.

A ticket is **never created by an agent pressing a button.** `TicketLinkerService` puts
every inbound message on one ([0003](../architecture/0003-ticket-auto-linking-contract.md)),
and 0002's endpoint table has no `POST /tickets` for that reason. The inbox's context
panel therefore _reports_ the link rather than offering to make one. If a screen ever
needs a "create a ticket from this" affordance, the endpoint comes first.

Reporting it means reporting **what it says**: its reference, its status and priority as
the queue's own `TicketStatusBadge` and `TicketPriorityBadge`, and who is on it — a second
endpoint behind its own Suspense and error boundary, so a contact card is never held up or
taken down by a read about something attached to it (TAR-518).

## Every state (TAR-515)

A screen is not the happy path plus some fallbacks. Empty is the first thing a new
workspace sees, loading is what every screen is for its first few hundred milliseconds,
and error is the only one the reader did not ask for. All three are designed here, so a
new screen inherits them instead of inventing a third grey box.

### The anatomy

`EmptyState` and `ErrorState` are two spellings of one layout, `StateLayout`:

| Part        | Rule                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The frame   | **None.** No border, no dashed outline, no sunken slab. It sits on its container's surface                                                         |
| Position    | Centred in the container's **full available height** (`min-block-size: 100%`, which collapses where there is none)                                 |
| Icon        | `Icon size="lg"` (`--size-icon-lg`) in `--color-on-surface-subtle`, inside a `--radius-pill` `--color-surface-sunken` disc of `--size-state-plate` |
| Title       | `--font-size-heading-sm` / `--font-weight-strong`                                                                                                  |
| Description | `--font-size-body-sm` / `--color-on-surface-muted`, capped at `--measure-body`, two lines of copy at most                                          |
| Action      | A real `Button` or `TextLink`, in the tab order. Never a styled div                                                                                |
| Entrance    | Opacity, `--duration-fast`, `--easing-enter`                                                                                                       |

A dashed placeholder box is a wireframe artifact: it reads as "a component belongs here
and has not been built yet". The disc is what carries the weight the border used to, and
it is the one legitimate use of `--color-on-surface-subtle` — decoration at 2.6:1, never
text. The icon is `aria-hidden`; the title carries the meaning.

`tone="quiet"` drops the disc for a region that is **instructional rather than empty** —
the thread column before a conversation is picked. Icon, one line, no action. Nothing is
wrong there, and drawing an ordinary resting position like a state the reader landed in
overstates it.

### Every empty state names the next step

An empty state without an action is a dead end. Omit `action` only where there genuinely
is no next step, and then ask whether `tone="quiet"` is the honest spelling.

**Zero results is not the same state as never had any.** A filter that matched nothing
says what was filtered and offers to widen it; a search that matched nothing quotes the
term back and offers to clear it; an account with no data at all says so and offers to set
it up. Sharing one string between them is what makes a working search look broken. Every
list that can be filtered branches on it — see `ConversationList`, which has all three.

An action a role cannot perform is not offered: the inbox's "Connect a WhatsApp number"
appears only for a principal holding `channel:manage`.

### Loading

- Lists and tables: shape-matched skeletons (`DataTableSkeleton`, `ConversationRowSkeleton`).
  Never the word "Loading" as body text — it belongs in `LoadingAnnouncement`, which is
  visually hidden and is the one polite announcement the region makes.
- Cards and panels: skeleton blocks matching the card's real layout, never a centred spinner.
- `Spinner` is correct **only inside a control the reader just pressed**.
- Shimmer runs at `--duration-slow`; the token layer flattens it to a static tint under
  `prefers-reduced-motion`, so no component branches on the preference.

### Error, and partial data

- **Every recoverable error offers a retry.** One without is a claim that retrying cannot
  help; `ContactUnavailable` and `ThreadUnavailable` are that claim made deliberately,
  which is why they are empty states with a way back rather than error states.
- **Section-scoped, not page-scoped.** Every independently-failing part of a composed
  screen is wrapped in `SectionErrorBoundary` (`LazyBoundary` brings its own), so one
  broken widget never blanks a page. Where several sections come out of **one** fetch, as
  the dashboard's three do, the read's boundary belongs at the page and the render's
  boundary still belongs per section.
- `ErrorState` is `role="alert"`. It has replaced the content the reader asked for, and a
  retry on offer does not change that — so it interrupts. It is also why the politeness is
  not derived from `onRetry`: `Spinner` is already a `role="status"`, and a failed section
  competing with every pending button for one announcement helps nobody.
- **Partial data is the polite half of that rule**, and it is not an error state: the data
  that loaded stays on screen and an inline `Notice` above it says what is missing, with a
  retry where there is something to retry. `MessageList`'s "older messages" notice is the
  instance — it says the stream starts where the fetch did, and offers nothing because
  paging further back has no endpoint yet.
- A chunk that 404s after a deploy is handled separately by `SectionErrorBoundary`: a
  reload, not a retry that can never succeed.

### Motion

Empty, loading and error content fades in over `--duration-fast`. The skeleton-to-content
swap is the incoming half of a cross-fade rather than a true one — React unmounts the
Suspense fallback the moment the content is ready, so keeping both on screen to dissolve
between them would mean drawing the section twice. Under `prefers-reduced-motion` the
token layer takes the durations to 1ms and `StateLayout` drops the animation outright.

## What a new screen inherits

Compose these and the screen matches this document without you specifying a colour or a
space:

| You need                | Use                                                |
| ----------------------- | -------------------------------------------------- |
| The frame               | Nothing — `app/(app)/layout.tsx` already has it    |
| Page gutter and rhythm  | `PageShell`, then `Stack`                          |
| A full-height workspace | `PageShell variant="fill"`                         |
| The page title          | `PageHeader`                                       |
| A section               | `SectionCard`                                      |
| A table                 | `DataTable` + `DataTableSkeleton`                  |
| Tabs                    | `Tabs`                                             |
| A filter row            | `FilterBar`                                        |
| Filter pills            | `FilterPills`                                      |
| A search filter         | `SearchField`                                      |
| A single choice         | `Select` (`variant="filter"` above a list)         |
| A date range            | `DateRangeField`                                   |
| Collapsed filters       | `FilterMenu` + `ActiveFilterChips`                 |
| A status chip or count  | `Badge` — see "Status vocabulary" for how many     |
| The product's identity  | `BrandLockup` — mark plus wordmark, logo-aware     |
| A link that acts        | `ButtonLink` — a navigation with a button's weight |
| An icon                 | `Icon`                                             |
| A person's initial      | `Avatar`                                           |
| A popup of actions      | `MenuButton`                                       |
| Explaining a figure     | `InfoPopover` — never prose under the number       |
| Loading, empty, error   | `Skeleton`, `EmptyState`, `ErrorState`             |
| A link off-app          | `TextLink isExternal`                              |

If a screen needs something not on that list, add it to `components/ui/` with a usage
comment and add a row here. A one-off in a feature folder that a second feature then
copies is how a design system stops being one.

## Changing this document

The token files and this document move together. If you change a value in
`primitives.css` or `semantic.css`, change the table here in the same pull request, and
re-measure any contrast pair you touched. If you need a pattern this document does not
have, add it here first — a pattern that exists only in one screen's code is not a
pattern, it is that screen's opinion.

TAR-29 will add per-tenant overrides on top of this. It changes token _values_ under a
tenant selector; it does not change which roles exist, and it never touches a component.
Keep that possible: a component that reads a primitive, or a screen that hardcodes a
brand colour, is the thing that breaks white-labelling later.
