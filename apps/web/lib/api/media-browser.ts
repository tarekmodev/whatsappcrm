import {
  MediaUploadResponseSchema,
  MEDIA_UPLOAD_FIELD,
  type MediaUploadResponse,
} from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { toApiRequestError } from '@/lib/api/error';

/**
 * `POST /api/v1/media` — the outbound upload the composer spends before a send.
 *
 * Made **by the browser**, to the same-origin `/api` path `next.config.mjs`
 * rewrites, for the same reason `auth-browser.ts` gives: the cookie is
 * first-party there under a white-label domain. But this one has a second reason
 * that is its own, and it is the stronger of the two — a server action's request
 * body is buffered by the Next process, and WhatsApp's document ceiling is
 * 100 MB. Routing that through a server action would put a hundred megabytes of
 * somebody's PDF into the console's memory to achieve nothing: the bytes are
 * going to the API either way, and what comes back is a single id.
 *
 * `credentials: 'include'` and nothing else: no token is read, stored or
 * forwarded, and no `content-type` is set — `fetch` must write it itself so the
 * multipart boundary matches the body.
 *
 * The caller is expected to have checked the file against the contract's
 * `WHATSAPP_MEDIA_LIMITS` first, so an oversize or unsupported file is refused
 * before the upload rather than after it. This is not that check's substitute:
 * the API applies the same limits again, and Meta a third time.
 */
export async function uploadMedia(file: File): Promise<MediaUploadResponse> {
  if (typeof window === 'undefined') {
    throw new Error('Media uploads must be made by the browser, not by the server.');
  }

  if (webEnv.useMockApi) {
    return mockUpload();
  }

  const body = new FormData();

  body.append(MEDIA_UPLOAD_FIELD, file);

  const response = await fetch(`${webEnv.apiBaseUrl}${MEDIA_PATH}`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    body,
  });

  if (!response.ok) {
    throw await toApiRequestError(response);
  }

  return MediaUploadResponseSchema.parse(await response.json());
}

const MEDIA_PATH = '/v1/media';

/**
 * Mock mode's answer, because this one call cannot reach the fixture transport.
 *
 * Everything else in `lib/api` runs on the Next process, where `apiRequest`
 * switches to `mock/handlers.ts`. This runs in the browser and talks to `/api`
 * directly, so in mock mode it would hit an API that is not there and the
 * composer's attach control would be the one part of the inbox a reviewer could
 * not walk. It answers with an id the mock send handler accepts.
 */
function mockUpload(): MediaUploadResponse {
  return { mediaId: crypto.randomUUID() };
}
