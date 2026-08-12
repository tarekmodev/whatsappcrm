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
| `--color-accent-subtle`    | `green-100` | `green-700` | Selected rows, avatar backgrounds   |
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

### Surfaces

| Role              | Light       | Dark        |
| ----------------- | ----------- | ----------- |
| `--color-canvas`  | `slate-50`  | `slate-950` |
| `--color-surface` | `white`     | `slate-900` |
| `--color-border`  | `slate-200` | `slate-700` |

Light grey canvas, white cards, hairline borders. A card is separated from the canvas by
its **border** first and its shadow second — a shadow doing the whole job reads as a
floating panel rather than a section of a page.

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

| Region  | Component                                  | Notes                                                                       |
| ------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Rail    | `apps/web/components/shell/AppSidebar.tsx` | Fixed, collapsible, icon + label, More/Less past five entries, footer slot  |
| Top bar | `apps/web/components/shell/AppTopBar.tsx`  | Search, quick create, account menu; the drawer trigger below the breakpoint |
| Canvas  | `apps/web/components/shell/PageShell.tsx`  | Gutter and vertical rhythm for the sections                                 |
| Drawer  | `apps/web/components/shell/MobileMenu.tsx` | The rail, below 48rem                                                       |

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
  the navigation.
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

## Structural patterns

### List views

Contacts, Tickets, and the agents table today:

1. `PageHeader` — the `<h1>` and the one primary action.
2. A filter row: `FilterPills` for the two or three mutually exclusive scopes, and a
   `Field`-wrapped search or select for anything with more options than that.
3. `DataTable` inside a `SectionCard`.
4. Row actions **inline in the last column**, as real buttons or links. Never hover-only:
   a touch device has no hover, and a keyboard user has no way to reveal one.

Every filter lives in the URL, never in component state. A refresh, a copied link and the
back button must reproduce the same list. Below 48rem `DataTable` re-flows each row into a
stacked card with its column headers repeated per cell — the same markup, no second table.

### Detail views

A contact, a ticket, a conversation:

1. A left summary panel with the key fields, which stays put.
2. A main area whose content is chosen by a `Tabs` strip — activity, then whatever else
   the entity has.

The tab is a real link and the active tab is in the URL, for the same reason the filters
are. Below the breakpoint the summary panel stacks above the tabbed area rather than
sitting beside it.

### The inbox

Four regions inside the console frame, owned by `InboxLayout`: the filter column, the
conversation list, the open thread, and the context panel beside it. Below 64rem one
region is on screen at a time and the filters collapse into their own disclosure; from
64rem the first three sit side by side with the context panel as a band under them; from
90rem the context panel takes its own column.

The filter entries are data (`features/inbox/inbox-filters.ts`), each a scope plus an
optional status — so there is no entry the conversations endpoint cannot answer. The
composer's destination (customer, or internal note) is a labelled tab strip, never a mode.

### Ticket status

A column in the list, rendered as a `Badge`. Not a pipeline, not a board, not a drag
target. A board is a different story and a different data shape; do not build half of one
into a list view.

A ticket is **never created by an agent pressing a button.** `TicketLinkerService` puts
every inbound message on one ([0003](../architecture/0003-ticket-auto-linking-contract.md)),
and 0002's endpoint table has no `POST /tickets` for that reason. The inbox's context
panel therefore _reports_ the link rather than offering to make one. If a screen ever
needs a "create a ticket from this" affordance, the endpoint comes first.

## What a new screen inherits

Compose these and the screen matches this document without you specifying a colour or a
space:

| You need               | Use                                             |
| ---------------------- | ----------------------------------------------- |
| The frame              | Nothing — `app/(app)/layout.tsx` already has it |
| Page gutter and rhythm | `PageShell`, then `Stack`                       |
| The page title         | `PageHeader`                                    |
| A section              | `SectionCard`                                   |
| A table                | `DataTable` + `DataTableSkeleton`               |
| Tabs                   | `Tabs`                                          |
| Filter pills           | `FilterPills`                                   |
| An icon                | `Icon`                                          |
| A person's initial     | `Avatar`                                        |
| A popup of actions     | `MenuButton`                                    |
| Loading, empty, error  | `Skeleton`, `EmptyState`, `ErrorState`          |

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
