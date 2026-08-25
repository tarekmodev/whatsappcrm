// Shared API contract. Single source of truth for `apps/api` and `apps/web`.
//
// TAR-38 established the envelope, pagination and health shapes. TAR-39 adds the
// resource, auth, billing, usage, realtime and webhook contracts, plus the error
// taxonomy that goes inside TAR-38's envelope.
//
// Conventions every file here follows are documented in
// `docs/architecture/0002-architecture-and-api-contract.md`.

// --- Foundations -----------------------------------------------------------
export * from './common';
export * from './error';
export * from './error-codes';
export * from './health';
export * from './pagination';

// --- Identity, tenancy and access -------------------------------------------
export * from './auth';
export * from './onboarding';
export * from './rbac';
export * from './signup';
export * from './tenant';
export * from './branding-theme';
export * from './users';

// --- Platform administration ------------------------------------------------
export * from './admin';

// --- Routing and assignment -------------------------------------------------
export * from './assignment';

// --- Automation -------------------------------------------------------------
export * from './workflows';

// --- AI chatbot -------------------------------------------------------------
export * from './ai';

// --- CRM, inbox and helpdesk ------------------------------------------------
export * from './canned-responses';
export * from './contacts';
export * from './conversations';
export * from './escalations';
export * from './media';
export * from './messages';
export * from './sla';
export * from './tickets';
export * from './ticket-linking';

// --- Channels ---------------------------------------------------------------
export * from './channels';

// --- WhatsApp channel -------------------------------------------------------
export * from './whatsapp';

// --- Channel ingestion ------------------------------------------------------
export * from './webhooks';

// --- Reporting --------------------------------------------------------------
export * from './reporting';

// --- Realtime ---------------------------------------------------------------
export * from './realtime';

// --- Commerce ---------------------------------------------------------------
export * from './billing';
export * from './usage';
