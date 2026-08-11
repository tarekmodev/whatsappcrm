/**
 * Where the Socket.IO server sits on the API's own origin.
 *
 * The value moved to `@whatsappcrm/contracts` when TAR-71 built the console
 * client, for the reason this file already gave: three places have to agree, and
 * the third one lives in `apps/web`, which cannot import from `apps/api`. It is
 * re-exported rather than deleted so every call site inside the API keeps
 * reading its own module.
 */
export { REALTIME_PATH } from '@whatsappcrm/contracts';
