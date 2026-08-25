import { z } from 'zod';

import type { PlanFeature } from './billing';

/**
 * The `Channel` vocabulary — ADR 0013, decisions 1 and 4.
 *
 * A **channel** is one connected messaging endpoint: a WhatsApp number, an
 * Instagram professional account, a Facebook Page. `channels` is the supertype
 * row every one of them has (class-table inheritance), and provider-specific
 * columns stay on their own table joined on a shared primary key —
 * `whatsapp_accounts` is the first of those.
 *
 * This file holds only the two enums the database declares plus the one mapping
 * that connects a kind to its entitlement. The adapter ports (`InboundChannelAdapter`,
 * `OutboundChannelAdapter`, `SendPolicy`) are ADR 0013 decision 3 and land with
 * the backend refactor (TAR-820), not here: TAR-819 is the data model, and a
 * port with no implementation is a shape nobody has had to satisfy yet.
 */

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * Every kind of channel the platform can hold a row for.
 *
 * Mirrors the `channel_kind` PostgreSQL enum exactly, in the same order. The two
 * are a pair: adding a kind here without the matching `ALTER TYPE ... ADD VALUE`
 * produces a value the database refuses, and adding it there alone produces rows
 * this package cannot parse.
 *
 * `whatsapp` is first because it is the one that exists today — every WhatsApp
 * number already connected is a `channels` row of this kind, carrying the id its
 * `whatsapp_accounts` row already had.
 */
export const CHANNEL_KINDS = ['whatsapp', 'instagram', 'messenger'] as const;
export const ChannelKindSchema = z.enum(CHANNEL_KINDS);
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/**
 * Whether a channel is attached and receiving.
 *
 * The same three values `WhatsappAccountStatus` already carried, moved up to the
 * supertype because they are true of every channel. **Sendability is a separate
 * axis and stays per-provider** — `whatsapp_accounts.registration_status` is
 * what says a number may send, and a number can be `connected` here and
 * `unregistered` there at the same time. That is the reason the two cannot be
 * one column, and generalising the wrong one would erase it.
 */
export const CHANNEL_STATUSES = ['connected', 'disconnected', 'error'] as const;
export const ChannelStatusSchema = z.enum(CHANNEL_STATUSES);
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Entitlement mapping
// ---------------------------------------------------------------------------

/**
 * The `PLAN_FEATURES` entry that gates connecting a channel of each kind
 * (ADR 0013 decision 4, TAR-808 AC3).
 *
 * A total `Record<ChannelKind, PlanFeature>` rather than a template literal, on
 * purpose. `` `channel_${kind}` `` would type-check forever: add a fourth kind
 * and TypeScript happily produces `channel_email`, a string no plan grants and
 * no `PlanFeature` names, and a **fail-closed** reader then refuses that channel
 * for every tenant on the platform with nothing in the diff to explain it. This
 * map does not compile until the feature exists.
 */
export const CHANNEL_FEATURE_BY_KIND: Readonly<Record<ChannelKind, PlanFeature>> = {
  whatsapp: 'channel_whatsapp',
  instagram: 'channel_instagram',
  messenger: 'channel_messenger',
};

/** `CHANNEL_FEATURE_BY_KIND` as a lookup, for call sites that hold a variable kind. */
export function channelFeature(kind: ChannelKind): PlanFeature {
  return CHANNEL_FEATURE_BY_KIND[kind];
}
