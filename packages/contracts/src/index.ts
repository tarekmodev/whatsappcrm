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
export * from './rbac';
export * from './tenant';
export * from './users';

// --- Platform administration ------------------------------------------------
export * from './admin';

// --- CRM, inbox and helpdesk ------------------------------------------------
export * from './contacts';
export * from './conversations';
export * from './messages';
export * from './tickets';

// --- WhatsApp channel -------------------------------------------------------
export * from './whatsapp';

// --- Channel ingestion ------------------------------------------------------
export * from './webhooks';

// --- Realtime ---------------------------------------------------------------
export * from './realtime';

// --- Commerce ---------------------------------------------------------------
export * from './billing';
export * from './usage';
